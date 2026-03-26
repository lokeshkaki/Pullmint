import { Job } from 'bullmq';
import { getObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { retryWithBackoff } from '@pullmint/shared/error-handling';
import type { Finding } from '@pullmint/shared/types';
import { createLLMProvider, LLMProvider } from '@pullmint/shared/llm';
import { getArchitecturePrompt } from '../prompts/architecture';
import { getSecurityPrompt } from '../prompts/security';
import { getPerformancePrompt } from '../prompts/performance';
import { getMaintainabilityPrompt } from '../prompts/maintainability';
import { parseDiff, filterDiff, getMaxDiffChars, type FilteredDiff } from '../diff-filter';

// Agent type → prompt function mapping
const AGENT_PROMPTS: Record<string, () => string> = {
  architecture: getArchitecturePrompt,
  security: getSecurityPrompt,
  performance: getPerformancePrompt,
  style: getMaintainabilityPrompt,
};

// Agent type → model mapping
const AGENT_MODELS: Record<string, string> = {
  architecture: process.env.LLM_ARCHITECTURE_MODEL || 'claude-sonnet-4-6',
  security: process.env.LLM_SECURITY_MODEL || 'claude-sonnet-4-6',
  performance: process.env.LLM_PERFORMANCE_MODEL || 'claude-haiku-4-5-20251001',
  style: process.env.LLM_MAINTAINABILITY_MODEL || 'claude-haiku-4-5-20251001',
};

let llmProvider: LLMProvider | null = null;

export interface AgentJobData {
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
  agentType: string;
  diffRef: string; // MinIO key where diff is stored
  repoKnowledge?: string; // Optional module narratives
}

export interface AgentResult {
  agentType: string;
  findings: Finding[];
  riskScore: number;
  summary: string;
  model: string;
  tokens: number;
  latencyMs: number;
  status: 'completed' | 'failed';
}

export async function processAgentJob(job: Job<AgentJobData>): Promise<AgentResult> {
  const { executionId, prEvent, agentType, diffRef, repoKnowledge } = job.data;
  const startTime = Date.now();

  addTraceAnnotations({ executionId, agentType });

  const promptFn = AGENT_PROMPTS[agentType];
  const model = AGENT_MODELS[agentType];

  if (!promptFn) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  if (!llmProvider) {
    llmProvider = createLLMProvider();
  }

  // Fetch diff from MinIO
  const diff = await getObject(
    process.env.ANALYSIS_RESULTS_BUCKET || 'pullmint-analysis-results',
    diffRef
  );

  // Build user prompt (same format as buildAnalysisPrompt in analysis.ts)
  const maxChars = getMaxDiffChars(agentType);
  const parsedDiff = parseDiff(diff);
  const filtered: FilteredDiff = filterDiff(parsedDiff, agentType, maxChars);

  const truncatedDiff = filtered.diff;

  let userContent = `<pr_title>${prEvent.title}</pr_title>\n`;
  if (repoKnowledge) {
    userContent += `${repoKnowledge}\n`;
  }
  userContent += `<diff>\n${truncatedDiff}\n</diff>`;

  // Call LLM with retry (same pattern as analysis.ts)
  const maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '2000', 10);

  const response = await retryWithBackoff(
    async () =>
      llmProvider!.chat({
        model,
        maxTokens,
        systemPrompt: promptFn(),
        userMessage: userContent,
        temperature: 0.3,
      }),
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000, backoffMultiplier: 2, jitter: true }
  );

  const responseText = response.text;

  const parsed = parseAgentResponse(responseText, agentType);

  if (filtered.wasTruncated || filtered.excludedFiles > 0) {
    const infoFinding: Finding = {
      type: agentType as Finding['type'],
      severity: 'info',
      title: 'Partial diff analysis',
      description:
        `Analyzed ${filtered.includedFiles} of ${filtered.includedFiles + filtered.excludedFiles} changed files ` +
        `(${filtered.excludedFiles} excluded by relevance filter or size limit). ` +
        `Original diff: ${filtered.originalCharCount.toLocaleString()} characters.` +
        (filtered.excludedFilePaths.length > 0
          ? ` Excluded: ${filtered.excludedFilePaths.slice(0, 5).join(', ')}${filtered.excludedFilePaths.length > 5 ? ` and ${filtered.excludedFilePaths.length - 5} more` : ''}.`
          : ''),
    };

    parsed.findings.push(infoFinding);
  }

  // Calculate tokens
  const tokens = response.inputTokens + response.outputTokens;
  const latencyMs = Date.now() - startTime;

  const result: AgentResult = {
    agentType,
    findings: parsed.findings,
    riskScore: parsed.riskScore,
    summary: parsed.summary,
    model,
    tokens,
    latencyMs,
    status: 'completed',
  };

  // Return value is stored by BullMQ and readable by the parent (synthesizer) job
  return result;
}

/**
 * Parse LLM response text into findings and risk score.
 * Enforces type field matches the agent's expected type.
 * Same parsing logic as analysis.ts parseAnalysis(), with type filtering added.
 */
function parseAgentResponse(
  text: string,
  expectedType: string
): { findings: Finding[]; riskScore: number; summary: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { findings: [], riskScore: 50, summary: '' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      findings?: unknown[];
      riskScore?: unknown;
      summary?: unknown;
    };

    const findings: Finding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f): f is Finding => {
        return f !== null && typeof f === 'object' && (f as Finding).type === expectedType;
      })
      .map((f: Finding) => ({
        type: f.type,
        severity: f.severity,
        title: String(f.title || ''),
        description: String(f.description || ''),
        ...(f.file != null ? { file: String(f.file) } : {}),
        ...(typeof f.line === 'number' ? { line: f.line } : {}),
        ...(f.suggestion != null ? { suggestion: String(f.suggestion) } : {}),
      }));

    const riskScore = Math.max(
      0,
      Math.min(100, Math.round(typeof parsed.riskScore === 'number' ? parsed.riskScore : 50))
    );
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    return { findings, riskScore, summary };
  } catch {
    return { findings: [], riskScore: 50, summary: '' };
  }
}
