import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import { retryWithBackoff } from '../../services/shared/error-handling';
import { createLLMProvider, type LLMProvider } from '../../services/shared/llm';
import {
  DEFAULT_CONFIG,
  filterFindingsBySeverity,
  pullmintConfigSchema,
  type PullmintConfig,
} from '../../services/shared/pullmint-config';
import type { Finding } from '../../services/shared/types';
import { deduplicateFindings } from '../../services/workers/src/dedup';
import {
  filterDiff,
  getMaxDiffChars,
  parseDiff,
  type FilteredDiff,
} from '../../services/workers/src/diff-filter';
import { getArchitecturePrompt } from '../../services/workers/src/prompts/architecture';
import { getMaintainabilityPrompt } from '../../services/workers/src/prompts/maintainability';
import { getPerformancePrompt } from '../../services/workers/src/prompts/performance';
import { getSecurityPrompt } from '../../services/workers/src/prompts/security';

const ALL_AGENTS = ['architecture', 'security', 'performance', 'style'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const MULTI_AGENT_MIN_DIFF_LINES = parseInt(process.env.MULTI_AGENT_MIN_DIFF_LINES ?? '200', 10);
const SUMMARY_MODEL = process.env.LLM_SUMMARY_MODEL ?? 'claude-haiku-4-5-20251001';

type AgentType = (typeof ALL_AGENTS)[number];

const AGENT_PROMPTS: Record<AgentType, () => string> = {
  architecture: getArchitecturePrompt,
  security: getSecurityPrompt,
  performance: getPerformancePrompt,
  style: getMaintainabilityPrompt,
};

function isSeverity(value: unknown): value is Finding['severity'] {
  return SEVERITIES.includes(value as (typeof SEVERITIES)[number]);
}

const AGENT_MODELS: Record<AgentType, string> = {
  architecture: process.env.LLM_ARCHITECTURE_MODEL ?? 'claude-sonnet-4-6',
  security: process.env.LLM_SECURITY_MODEL ?? 'claude-sonnet-4-6',
  performance: process.env.LLM_PERFORMANCE_MODEL ?? 'claude-haiku-4-5-20251001',
  style: process.env.LLM_MAINTAINABILITY_MODEL ?? 'claude-haiku-4-5-20251001',
};

const BASE_WEIGHTS: Record<AgentType, number> = {
  architecture: 0.35,
  security: 0.35,
  performance: 0.15,
  style: 0.15,
};

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  author: string;
  title: string;
}

export interface AgentRunResult {
  agentType: AgentType;
  findings: Finding[];
  riskScore: number;
  summary: string;
  model: string;
  tokens: number;
  latencyMs: number;
  status: 'completed' | 'failed';
  error?: string;
}

export interface AnalysisRunResult {
  findings: Finding[];
  allFindings: Finding[];
  riskScore: number;
  summary: string;
  agentResults: AgentRunResult[];
  rawDiff: string;
  diffStats: {
    totalFiles: number;
    totalAddedLines: number;
    totalRemovedLines: number;
  };
}

export interface RunAnalysisOptions {
  prContext: PRContext;
  githubToken: string;
  severityThreshold: string;
  configPath: string;
  agentsInput: string;
}

export async function runAnalysis(opts: RunAnalysisOptions): Promise<AnalysisRunResult> {
  const { prContext, githubToken, severityThreshold, configPath, agentsInput } = opts;
  const octokit = new Octokit({ auth: githubToken });

  const rawDiff = await fetchPRDiff(octokit, prContext);
  const repoConfig = loadRepoConfig(configPath);
  const enabledAgents = resolveEnabledAgents(agentsInput, repoConfig, rawDiff);
  const llmProvider = createLLMProvider();
  const parsedDiff = parseDiff(rawDiff);

  const agentPromises = enabledAgents.map((agentType) =>
    runAgent({
      agentType,
      rawDiff,
      prContext,
      llmProvider,
      userIgnorePaths: repoConfig.ignore_paths,
    })
  );

  const settled = await Promise.allSettled(agentPromises);
  const agentResults: AgentRunResult[] = settled.map((settledResult, index) => {
    const agentType = enabledAgents[index];
    if (settledResult.status === 'fulfilled') {
      return settledResult.value;
    }

    console.error(`Agent ${agentType} failed:`, settledResult.reason);
    return {
      agentType,
      findings: [],
      riskScore: 0,
      summary: '',
      model: AGENT_MODELS[agentType],
      tokens: 0,
      latencyMs: 0,
      status: 'failed',
      error:
        settledResult.reason instanceof Error
          ? settledResult.reason.message
          : String(settledResult.reason),
    };
  });

  const successfulResults = agentResults.filter(
    (result): result is AgentRunResult & { status: 'completed' } => result.status === 'completed'
  );

  if (successfulResults.length === 0) {
    throw new Error('All analysis agents failed. Check your API key and model configuration.');
  }

  const allFindingsRaw = successfulResults.flatMap((result) => result.findings);
  const dedupedFindings = deduplicateFindings(allFindingsRaw);
  const finalRiskScore = computeWeightedRiskScore(successfulResults);
  const summary = await generateSummary(llmProvider, dedupedFindings);
  const filteredFindings = filterFindingsBySeverity(dedupedFindings, severityThreshold);

  return {
    findings: filteredFindings,
    allFindings: dedupedFindings,
    riskScore: finalRiskScore,
    summary,
    agentResults,
    rawDiff,
    diffStats: {
      totalFiles: parsedDiff.totalFiles,
      totalAddedLines: parsedDiff.totalAddedLines,
      totalRemovedLines: parsedDiff.totalRemovedLines,
    },
  };
}

async function fetchPRDiff(octokit: Octokit, prContext: PRContext): Promise<string> {
  const response = await retryWithBackoff(
    async () =>
      octokit.rest.pulls.get({
        owner: prContext.owner,
        repo: prContext.repo,
        pull_number: prContext.prNumber,
        mediaType: { format: 'diff' },
      }),
    { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2, jitter: true }
  );

  return response.data as unknown as string;
}

function loadRepoConfig(configPath: string): PullmintConfig {
  const absolutePath = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(absolutePath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(absolutePath, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('yaml') as { parse: (content: string) => unknown };
    const parsed = parse(raw);
    const result = pullmintConfigSchema.safeParse(parsed);

    if (!result.success) {
      console.warn(
        `[pullmint] Invalid .pullmint.yml — using defaults. Errors: ${JSON.stringify(result.error.issues)}`
      );
      return DEFAULT_CONFIG;
    }

    return result.data;
  } catch (error) {
    console.warn(`[pullmint] Failed to read ${configPath} — using defaults:`, error);
    return DEFAULT_CONFIG;
  }
}

function resolveEnabledAgents(
  agentsInput: string,
  repoConfig: PullmintConfig,
  rawDiff: string
): AgentType[] {
  let enabledAgents = ALL_AGENTS.filter((agentType) => repoConfig.agents[agentType] !== false);

  if (agentsInput !== 'all') {
    const requested = new Set(
      agentsInput
        .split(',')
        .map((agentType) => agentType.trim().toLowerCase())
        .filter((agentType): agentType is AgentType => ALL_AGENTS.includes(agentType as AgentType))
    );

    enabledAgents = enabledAgents.filter((agentType) => requested.has(agentType));
  }

  if (!enabledAgents.includes('security')) {
    enabledAgents.push('security');
  }

  const diffLines = rawDiff.split('\n').length;
  if (diffLines < MULTI_AGENT_MIN_DIFF_LINES) {
    return enabledAgents.filter(
      (agentType): agentType is AgentType =>
        agentType === 'architecture' || agentType === 'security'
    );
  }

  return enabledAgents;
}

interface AgentRunOptions {
  agentType: AgentType;
  rawDiff: string;
  prContext: PRContext;
  llmProvider: LLMProvider;
  userIgnorePaths: string[];
}

async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { agentType, rawDiff, prContext, llmProvider, userIgnorePaths } = opts;
  const startTime = Date.now();
  const promptFn = AGENT_PROMPTS[agentType];
  const model = AGENT_MODELS[agentType];
  const maxChars = getMaxDiffChars(agentType);
  const parsedDiff = parseDiff(rawDiff);
  const filtered: FilteredDiff = filterDiff(parsedDiff, agentType, maxChars, userIgnorePaths);

  let userContent = `<pr_title>${prContext.title}</pr_title>\n`;
  userContent += `<diff>\n${filtered.diff}\n</diff>`;

  const maxTokens = parseInt(process.env.LLM_MAX_TOKENS ?? '2000', 10);
  const response = await retryWithBackoff(
    async () =>
      llmProvider.chat({
        model,
        maxTokens,
        systemPrompt: promptFn(),
        userMessage: userContent,
        temperature: 0.3,
      }),
    { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000, backoffMultiplier: 2, jitter: true }
  );

  const parsed = parseAgentResponse(response.text, agentType);
  if (filtered.wasTruncated || filtered.excludedFiles > 0) {
    parsed.findings.push({
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
    });
  }

  return {
    agentType,
    findings: parsed.findings,
    riskScore: parsed.riskScore,
    summary: parsed.summary,
    model,
    tokens: response.inputTokens + response.outputTokens,
    latencyMs: Date.now() - startTime,
    status: 'completed',
  };
}

function parseAgentResponse(
  text: string,
  expectedType: AgentType
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

    const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).flatMap((value) => {
      if (!value || typeof value !== 'object') {
        return [];
      }

      const candidate = value as Partial<Finding>;
      if (
        candidate.type !== expectedType ||
        !isSeverity(candidate.severity) ||
        typeof candidate.title !== 'string' ||
        typeof candidate.description !== 'string'
      ) {
        return [];
      }

      const finding: Finding = {
        type: expectedType,
        severity: candidate.severity,
        title: candidate.title,
        description: candidate.description,
      };

      if (typeof candidate.file === 'string') {
        finding.file = candidate.file;
      }
      if (typeof candidate.line === 'number') {
        finding.line = candidate.line;
      }
      if (typeof candidate.suggestion === 'string') {
        finding.suggestion = candidate.suggestion;
      }

      return [finding];
    });

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

function computeWeightedRiskScore(successfulResults: AgentRunResult[]): number {
  const activeWeights = successfulResults.reduce<Record<AgentType, number>>(
    (accumulator, result) => {
      accumulator[result.agentType] = BASE_WEIGHTS[result.agentType];
      return accumulator;
    },
    {} as Record<AgentType, number>
  );

  const totalWeight = Object.values(activeWeights).reduce((sum, weight) => sum + weight, 0);
  const weightedScore = successfulResults.reduce((sum, result) => {
    const normalizedWeight = totalWeight > 0 ? activeWeights[result.agentType] / totalWeight : 0;
    return sum + result.riskScore * normalizedWeight;
  }, 0);

  return Math.max(0, Math.min(100, Math.round(weightedScore)));
}

async function generateSummary(llmProvider: LLMProvider, findings: Finding[]): Promise<string> {
  if (findings.length === 0) {
    return '';
  }

  const findingsSummaryInput = findings
    .map((finding) => {
      return `[${finding.severity.toUpperCase()}] ${finding.type}: ${finding.title} — ${finding.description}`;
    })
    .join('\n');

  try {
    const response = await retryWithBackoff(
      async () =>
        llmProvider.chat({
          model: SUMMARY_MODEL,
          maxTokens: 300,
          systemPrompt:
            'Given these code review findings from multiple specialized reviewers, write a 2-3 sentence summary of the most important issues for the PR author. Be direct and specific. Do not list every finding — highlight what matters most.',
          userMessage: findingsSummaryInput,
          temperature: 0.3,
        }),
      { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 10000 }
    );

    return response.text;
  } catch (error) {
    console.warn('[pullmint] Failed to generate summary, continuing without it:', error);
    return '';
  }
}
