import { Job } from 'bullmq';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig, getConfigOptional } from '@pullmint/shared/config';
import { putObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { createStructuredError, retryWithBackoff } from '@pullmint/shared/error-handling';
import { publishExecutionUpdate } from '@pullmint/shared/execution-events';
import { createLLMProvider, LLMProvider } from '@pullmint/shared/llm';
import { deduplicateFindings } from '../dedup';
import { buildAnalysisCheckpoint } from '../checkpoint';
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

    if (dedupedFindings.length > 0) {
      if (!llmProvider) {
        llmProvider = createLLMProvider();
      }

      const findingsSummaryInput = dedupedFindings
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
        findings: dedupedFindings,
        summary: synthesizedSummary,
        agentResults: agentMeta,
        analyzedAt: Date.now(),
      })
    );

    const cacheExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .insert(schema.llmCache)
      .values({
        cacheKey,
        findings: dedupedFindings as unknown[],
        riskScore: finalRiskScore,
        contextQuality: 'none',
        expiresAt: cacheExpiresAt,
      })
      .onConflictDoUpdate({
        target: schema.llmCache.cacheKey,
        set: {
          findings: dedupedFindings as unknown[],
          riskScore: finalRiskScore,
          contextQuality: 'none',
          expiresAt: cacheExpiresAt,
        },
      });

    const skippedAgents = ALL_AGENT_TYPES.filter((agentType) => !agentTypes.includes(agentType));

    await publishExecutionUpdate(executionId, {
      status: 'completed',
      findings: dedupedFindings as unknown[],
      riskScore: finalRiskScore,
      s3Key,
      checkpoints: [checkpoint1] as unknown as Record<string, unknown>,
      agentType: 'architecture',
      metadata: {
        agentResults: agentMeta,
        synthesisTokens,
        synthesisLatencyMs,
        totalFindings: allFindings.length,
        dedupedFindings: dedupedFindings.length,
        skippedAgents,
        calibrationApplied: calibrationFactor,
        cached: false,
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
      findingsCount: dedupedFindings.length,
      s3Key,
      summary: synthesizedSummary,
      metadata: {
        agentResults: agentMeta,
        synthesisTokens,
        synthesisLatencyMs,
        totalFindings: allFindings.length,
        dedupedFindings: dedupedFindings.length,
        skippedAgents,
        calibrationApplied: calibrationFactor,
        cached: false,
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
        `Risk=${finalRiskScore}, Findings=${allFindings.length}→${dedupedFindings.length} (deduped), ` +
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
