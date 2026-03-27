import { Job } from 'bullmq';
import { getDb } from '@pullmint/shared/db';
import { getObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { retryWithBackoff } from '@pullmint/shared/error-handling';
import { recordTokenUsage } from '@pullmint/shared/cost-tracker';
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

const DEFAULT_CUSTOM_AGENT_MODEL =
  process.env.LLM_CUSTOM_AGENT_MODEL ?? 'claude-haiku-4-5-20251001';

let llmProvider: LLMProvider | null = null;

/**
 * Wraps a custom agent's user prompt with standardized JSON response format instructions.
 * The format block is appended — never prepended — so the user's system prompt context
 * establishes role and domain first.
 */
function buildCustomAgentPrompt(userPrompt: string, agentType: string): string {
  return `${userPrompt}

## Response Format

Respond with a JSON object containing:
- "findings": array of finding objects, each with:
  - "type": must be "${agentType}"
  - "severity": one of "critical", "high", "medium", "low", "info"
  - "title": brief one-line title (max 100 characters)
  - "description": detailed explanation of the issue
  - "file": (optional) affected file path relative to repo root
  - "line": (optional) affected line number in the new version of the file
  - "suggestion": (optional) specific actionable fix
- "riskScore": integer 0-100 representing overall risk from this agent's perspective
- "summary": 1-2 sentence summary of the most important findings

Example:
{
  "findings": [
    {
      "type": "${agentType}",
      "severity": "high",
      "title": "Example finding title",
      "description": "Detailed explanation of the issue.",
      "file": "src/components/Button.tsx",
      "line": 42,
      "suggestion": "Consider adding role attribute."
    }
  ],
  "riskScore": 35,
  "summary": "One high-severity issue found."
}`;
}

export interface CustomAgentJobConfig {
  prompt: string;
  model?: string;
  includePaths?: string[];
  excludePaths?: string[];
  maxDiffChars: number;
  severityFilter?: string;
}

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
  userIgnorePaths?: string[];
  customAgentConfig?: CustomAgentJobConfig; // NEW: present only for custom agents
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
  const { executionId, prEvent, agentType, diffRef, repoKnowledge, userIgnorePaths } = job.data;
  const startTime = Date.now();

  addTraceAnnotations({ executionId, agentType });

  const isBuiltIn = agentType in AGENT_PROMPTS;

  let systemPrompt: string;
  let model: string;
  let customIncludePaths: string[] | undefined;
  let customExcludePaths: string[] | undefined;
  let customMaxDiffChars: number | undefined;

  if (isBuiltIn) {
    const promptFn = AGENT_PROMPTS[agentType];
    systemPrompt = promptFn();
    model = AGENT_MODELS[agentType];
  } else {
    const config = job.data.customAgentConfig;
    if (!config) {
      throw new Error(`Custom agent type "${agentType}" has no customAgentConfig in job data`);
    }
    systemPrompt = buildCustomAgentPrompt(config.prompt, agentType);
    model = config.model ?? DEFAULT_CUSTOM_AGENT_MODEL;
    customIncludePaths = config.includePaths;
    customExcludePaths = config.excludePaths;
    customMaxDiffChars = config.maxDiffChars;
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
  const maxChars = customMaxDiffChars ?? getMaxDiffChars(agentType);
  const parsedDiff = parseDiff(diff);

  // For custom agents, merge user ignore_paths + agent-level exclude_paths
  const allExcludePaths = [...(userIgnorePaths ?? []), ...(customExcludePaths ?? [])];

  const filtered: FilteredDiff = filterDiff(
    parsedDiff,
    agentType,
    maxChars,
    allExcludePaths.length > 0 ? allExcludePaths : undefined,
    customIncludePaths
  );

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
        systemPrompt,
        userMessage: userContent,
        temperature: 0.3,
      }),
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000, backoffMultiplier: 2, jitter: true }
  );

  const responseText = response.text;

  const parsed = parseAgentResponse(responseText, agentType);

  if (filtered.wasTruncated || filtered.excludedFiles > 0) {
    const infoFinding: Finding = {
      type: agentType,
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

  // Record token usage for cost tracking (best-effort, non-blocking)
  void recordTokenUsage(getDb(), {
    executionId,
    repoFullName: prEvent.repoFullName,
    agentType,
    model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

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
