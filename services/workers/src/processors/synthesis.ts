import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig, getConfigOptional } from '@pullmint/shared/config';
import { recordTokenUsage } from '@pullmint/shared/cost-tracker';
import { getObject, putObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { createStructuredError, retryWithBackoff } from '@pullmint/shared/error-handling';
import { publishExecutionUpdate } from '@pullmint/shared/execution-events';
import { createLLMProvider, LLMProvider } from '@pullmint/shared/llm';
import { FindingSchema } from '@pullmint/shared/schemas';
import { deduplicateFindings } from '../dedup';
import { buildAnalysisCheckpoint } from '../checkpoint';
import { fingerprintFindings } from '../finding-fingerprint';
import { analyzeFindingLifecycle } from '../finding-lifecycle';
import { z } from 'zod';
import type { Finding, AgentResultMeta, PREvent } from '@pullmint/shared/types';
import type { AgentResult } from './agent';

let llmProvider: LLMProvider | null = null;

export interface SynthesisJobData {
  executionId: string;
  prEvent: {
    prNumber: number;
    repoFullName: string;
    headSha: string;
    baseSha: string;
    author: string;
    title: string;
    orgId: string;
  };
  diffRef: string;
  agentTypes: string[];
  cacheKey: string;
  priorAgentResults?: Record<string, AgentResult>;
  rerunAgentTypes?: string[];
  priorExecutionId?: string;
}

const BASE_WEIGHTS: Record<string, number> = {
  architecture: 0.35,
  security: 0.35,
  performance: 0.15,
  style: 0.15,
};

const ALL_AGENT_TYPES = ['architecture', 'security', 'performance', 'style'];

function parseWeight(key: string, fallback: number): number {
  const rawValue = getConfigOptional(key);
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Load findings from a prior execution.
 * Tries MinIO first (s3Key from execution row), falls back to DB findings column.
 * Returns empty array on any failure — lifecycle analysis is non-critical.
 */
async function loadPriorFindings(
  priorExecutionId: string,
  db: ReturnType<typeof getDb>,
  analysisBucket: string
): Promise<Finding[]> {
  try {
    const [priorRow] = await db
      .select({
        s3Key: schema.executions.s3Key,
        findings: schema.executions.findings,
      })
      .from(schema.executions)
      .where(eq(schema.executions.executionId, priorExecutionId))
      .limit(1);

    if (!priorRow) return [];

    if (priorRow.s3Key) {
      try {
        const raw = await getObject(analysisBucket, priorRow.s3Key);
        if (raw) {
          const parsed = JSON.parse(raw) as { findings?: unknown[] };
          const result = z.array(FindingSchema).safeParse(parsed.findings ?? []);
          if (result.success) return result.data;
        }
      } catch {
        // Fall through to DB findings.
      }
    }

    const dbFindings = z
      .array(FindingSchema)
      .safeParse(Array.isArray(priorRow.findings) ? priorRow.findings : []);
    return dbFindings.success ? dbFindings.data : [];
  } catch (err) {
    console.warn({ err, priorExecutionId }, 'Failed to load prior findings for lifecycle analysis');
    return [];
  }
}

export async function processSynthesisJob(job: Job<SynthesisJobData>): Promise<void> {
  const { executionId, prEvent, agentTypes, cacheKey } = job.data;
  const db = getDb();
  const config = {
    analysisBucket: getConfig('ANALYSIS_RESULTS_BUCKET'),
  };

  console.log(`Synthesizing results for PR #${prEvent.prNumber} (execution: ${executionId})`);
  addTraceAnnotations({ executionId, synthesizer: 1 });

  try {
    const childrenValues = await job.getChildrenValues();

    const priorResults = job.data.priorAgentResults ?? {};
    const mergedResultsByAgent: Record<string, AgentResult> = { ...priorResults };

    const agentResults: AgentResult[] = [];
    const agentMeta: Record<string, AgentResultMeta> = {};

    for (const value of Object.values(childrenValues)) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const result = value as AgentResult;
      if (typeof result.agentType !== 'string') {
        continue;
      }

      mergedResultsByAgent[result.agentType] = result;
    }

    for (const result of Object.values(mergedResultsByAgent)) {
      if (!result || typeof result.agentType !== 'string') {
        continue;
      }

      if (result.status === 'completed') {
        agentResults.push(result);
      }

      agentMeta[result.agentType] = {
        findingsCount: result.findings?.length ?? 0,
        riskScore: result.riskScore ?? 0,
        model: result.model ?? 'unknown',
        tokens: result.tokens ?? 0,
        latencyMs: result.latencyMs ?? 0,
        status: result.status,
      };
    }

    for (const agentType of agentTypes) {
      if (!agentMeta[agentType]) {
        agentMeta[agentType] = {
          findingsCount: 0,
          riskScore: 0,
          model: 'unknown',
          tokens: 0,
          latencyMs: 0,
          status: 'failed',
        };
      }
    }

    if (agentResults.length === 0) {
      console.error(`All agents failed for execution ${executionId}`);
      await publishExecutionUpdate(executionId, {
        status: 'failed',
        metadata: { error: 'All analysis agents failed', agentResults: agentMeta },
      });
      return;
    }

    const allFindings: Finding[] = agentResults.flatMap((result) => result.findings);
    const dedupedFindings = deduplicateFindings(allFindings);

    const fingerprintedFindings = fingerprintFindings(dedupedFindings);

    let lifecycleResult: {
      findings: Finding[];
      resolved: Finding[];
      stats: { new: number; persisted: number; resolved: number };
    } | null = null;

    const { priorExecutionId } = job.data;
    if (priorExecutionId) {
      try {
        const priorFindings = await loadPriorFindings(priorExecutionId, db, config.analysisBucket);
        lifecycleResult = analyzeFindingLifecycle(fingerprintedFindings, priorFindings);
        console.log(
          `Lifecycle analysis for PR #${prEvent.prNumber}: ` +
            `new=${lifecycleResult.stats.new}, ` +
            `persisted=${lifecycleResult.stats.persisted}, ` +
            `resolved=${lifecycleResult.stats.resolved}`
        );
      } catch (lifecycleErr) {
        console.warn(
          { lifecycleErr, priorExecutionId },
          'Lifecycle analysis failed — treating all findings as new'
        );
        lifecycleResult = null;
      }
    }

    const finalFindings: Finding[] = lifecycleResult
      ? lifecycleResult.findings
      : fingerprintedFindings.map((f) => ({ ...f, lifecycle: 'new' as const }));

    const lifecycleStats = lifecycleResult?.stats ?? {
      new: finalFindings.length,
      persisted: 0,
      resolved: 0,
    };
    const resolvedFindings: Finding[] = lifecycleResult?.resolved ?? [];

    const weights: Record<string, number> = {
      architecture: parseWeight('AGENT_WEIGHT_ARCHITECTURE', BASE_WEIGHTS.architecture),
      security: parseWeight('AGENT_WEIGHT_SECURITY', BASE_WEIGHTS.security),
      performance: parseWeight('AGENT_WEIGHT_PERFORMANCE', BASE_WEIGHTS.performance),
      style: parseWeight('AGENT_WEIGHT_STYLE', BASE_WEIGHTS.style),
    };

    const activeWeights: Record<string, number> = {};
    for (const result of agentResults) {
      if (weights[result.agentType] !== undefined) {
        activeWeights[result.agentType] = weights[result.agentType];
      }
    }

    const totalWeight = Object.values(activeWeights).reduce((sum, current) => sum + current, 0);
    const normalizedWeights: Record<string, number> = {};
    for (const [agentType, weight] of Object.entries(activeWeights)) {
      normalizedWeights[agentType] = totalWeight > 0 ? weight / totalWeight : 0;
    }

    const weightedScore = agentResults.reduce((sum, result) => {
      return sum + result.riskScore * (normalizedWeights[result.agentType] ?? 0);
    }, 0);

    const finalRiskScore = Math.max(0, Math.min(100, Math.round(weightedScore)));

    const [owner, repo] = prEvent.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid repoFullName format: ${prEvent.repoFullName}`);
    }

    const octokit = await getGitHubInstallationClient(prEvent.repoFullName);
    const prEventWithExecution: PREvent & { executionId: string } = {
      ...prEvent,
      executionId,
    };

    const { checkpoint1, calibrationFactor } = await buildAnalysisCheckpoint(
      prEventWithExecution,
      finalRiskScore,
      [owner, repo],
      octokit,
      db
    );

    let synthesizedSummary = '';
    let synthesisTokens = 0;
    const synthesisStartTime = Date.now();

    if (finalFindings.length > 0) {
      if (!llmProvider) {
        llmProvider = createLLMProvider();
      }

      const findingsSummaryInput = finalFindings
        .map((finding) => {
          return `[${finding.severity.toUpperCase()}] ${finding.type}: ${finding.title} — ${finding.description}`;
        })
        .join('\n');

      try {
        const summaryResponse = await retryWithBackoff(
          async () =>
            llmProvider!.chat({
              model: 'claude-haiku-4-5-20251001',
              maxTokens: 300,
              systemPrompt:
                'Given these code review findings from multiple specialized reviewers, write a 2-3 sentence summary of the most important issues for the PR author. Be direct and specific. Do not list every finding — highlight what matters most.',
              userMessage: findingsSummaryInput,
              temperature: 0.3,
            }),
          { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000 }
        );

        synthesizedSummary = summaryResponse.text;
        synthesisTokens = summaryResponse.inputTokens + summaryResponse.outputTokens;

        // Record token usage for cost tracking (best-effort, non-blocking)
        void recordTokenUsage(getDb(), {
          executionId,
          repoFullName: prEvent.repoFullName,
          agentType: 'synthesis',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: summaryResponse.inputTokens,
          outputTokens: summaryResponse.outputTokens,
        });
      } catch (summaryError) {
        console.warn('Failed to generate LLM summary, continuing without it:', summaryError);
      }
    }

    const synthesisLatencyMs = Date.now() - synthesisStartTime;

    const s3Key = `executions/${executionId}/analysis.json`;
    await putObject(
      config.analysisBucket,
      s3Key,
      JSON.stringify({
        executionId,
        riskScore: finalRiskScore,
        findings: finalFindings,
        resolvedFindings,
        summary: synthesizedSummary,
        agentResults: agentMeta,
        lifecycle: lifecycleStats,
        analyzedAt: Date.now(),
      })
    );

    const cacheExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .insert(schema.llmCache)
      .values({
        cacheKey,
        findings: finalFindings as unknown[],
        riskScore: finalRiskScore,
        contextQuality: 'none',
        expiresAt: cacheExpiresAt,
      })
      .onConflictDoUpdate({
        target: schema.llmCache.cacheKey,
        set: {
          findings: finalFindings as unknown[],
          riskScore: finalRiskScore,
          contextQuality: 'none',
          expiresAt: cacheExpiresAt,
        },
      });

    const skippedAgents = ALL_AGENT_TYPES.filter((agentType) => !agentTypes.includes(agentType));

    await publishExecutionUpdate(executionId, {
      status: 'completed',
      findings: finalFindings as unknown[],
      riskScore: finalRiskScore,
      s3Key,
      checkpoints: [checkpoint1] as unknown as Record<string, unknown>,
      agentType: 'architecture',
      metadata: {
        agentResults: agentMeta,
        synthesisTokens,
        synthesisLatencyMs,
        totalFindings: allFindings.length,
        dedupedFindings: finalFindings.length,
        skippedAgents,
        calibrationApplied: calibrationFactor,
        cached: false,
        lifecycle: lifecycleStats,
        ...(job.data.rerunAgentTypes
          ? {
              incremental: true,
              rerunAgents: job.data.rerunAgentTypes,
            }
          : {}),
      },
    });

    await addJob(QUEUE_NAMES.GITHUB_INTEGRATION, 'analysis.complete', {
      ...prEvent,
      executionId,
      riskScore: finalRiskScore,
      findingsCount: finalFindings.length,
      s3Key,
      summary: synthesizedSummary,
      metadata: {
        agentResults: agentMeta,
        synthesisTokens,
        synthesisLatencyMs,
        totalFindings: allFindings.length,
        dedupedFindings: finalFindings.length,
        skippedAgents,
        calibrationApplied: calibrationFactor,
        cached: false,
        lifecycle: lifecycleStats,
        resolvedFindings,
        ...(job.data.rerunAgentTypes
          ? {
              incremental: true,
              rerunAgents: job.data.rerunAgentTypes,
            }
          : {}),
      },
    } as Record<string, unknown>);

    console.log(
      `Synthesis complete for PR #${prEvent.prNumber}: ` +
        `Risk=${finalRiskScore}, Findings=${allFindings.length}→${finalFindings.length} (deduped), ` +
        `Lifecycle: ${lifecycleStats.new} new / ${lifecycleStats.persisted} persisted / ${lifecycleStats.resolved} resolved, ` +
        `Agents=${agentResults.length}/${agentTypes.length} succeeded`
    );
  } catch (error) {
    const structuredError = createStructuredError(
      error instanceof Error ? error : new Error('Unknown error'),
      {
        context: 'synthesis-processor',
        prNumber: prEvent.prNumber,
        executionId,
      }
    );

    console.error('Error in synthesizer:', JSON.stringify(structuredError));

    try {
      await publishExecutionUpdate(executionId, {
        status: 'failed',
        metadata: { error: structuredError.message },
      });
    } catch (updateError) {
      console.error('Failed to update execution status:', {
        updateError,
        executionId,
      });
    }

    throw error;
  }
}
