import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLLMProvider, LLMProvider } from '@pullmint/shared/llm';
import { getConfigOptional } from '@pullmint/shared/config';
import { parseDiff, filterDiff, getMaxDiffChars } from '@pullmint/shared/diff-filter';
import { deduplicateFindings } from '@pullmint/shared/dedup';
import { getArchitecturePrompt } from '@pullmint/shared/prompts/architecture';
import { getSecurityPrompt } from '@pullmint/shared/prompts/security';
import { getPerformancePrompt } from '@pullmint/shared/prompts/performance';
import { getMaintainabilityPrompt } from '@pullmint/shared/prompts/maintainability';
import type { Finding } from '@pullmint/shared/types';
import { DEMO_SAMPLES } from '../demo-fixtures';

const AGENT_PROMPTS: Record<string, () => string> = {
  architecture: getArchitecturePrompt,
  security: getSecurityPrompt,
  performance: getPerformancePrompt,
  style: getMaintainabilityPrompt,
};

const AGENT_MODELS: Record<string, string> = {
  architecture: process.env.LLM_ARCHITECTURE_MODEL ?? 'claude-sonnet-4-6',
  security: process.env.LLM_SECURITY_MODEL ?? 'claude-sonnet-4-6',
  performance: process.env.LLM_PERFORMANCE_MODEL ?? 'claude-haiku-4-5-20251001',
  style: process.env.LLM_MAINTAINABILITY_MODEL ?? 'claude-haiku-4-5-20251001',
};

const BASE_WEIGHTS: Record<string, number> = {
  architecture: 0.35,
  security: 0.35,
  performance: 0.15,
  style: 0.15,
};

interface AgentRunResult {
  agentType: string;
  findings: Finding[];
  riskScore: number;
  status: 'completed' | 'failed';
  error?: string;
}

async function runAgent(
  llm: LLMProvider,
  agentType: string,
  diff: string,
  prTitle: string
): Promise<AgentRunResult> {
  try {
    const parsedDiff = parseDiff(diff);
    const maxChars = getMaxDiffChars(agentType);
    const filtered = filterDiff(parsedDiff, agentType, maxChars);
    const promptFn = AGENT_PROMPTS[agentType];
    const model = AGENT_MODELS[agentType];

    const userContent = `<pr_title>${prTitle}</pr_title>\n<diff>\n${filtered.diff}\n</diff>`;

    const response = await llm.chat({
      model,
      maxTokens: 2000,
      systemPrompt: promptFn(),
      userMessage: userContent,
      temperature: 0.3,
    });

    const parsed = parseAgentResponse(response.text, agentType);

    return {
      agentType,
      findings: parsed.findings,
      riskScore: parsed.riskScore,
      status: 'completed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { agentType, findings: [], riskScore: 0, status: 'failed', error: message };
  }
}

function parseAgentResponse(
  text: string,
  expectedType: string
): { findings: Finding[]; riskScore: number } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { findings: [], riskScore: 50 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { findings?: unknown[]; riskScore?: unknown };

    const findings: Finding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f): f is Finding => {
        return (
          f !== null &&
          typeof f === 'object' &&
          (f as Finding).type === expectedType &&
          typeof (f as Finding).title === 'string' &&
          typeof (f as Finding).description === 'string'
        );
      })
      .map((f: Finding) => ({
        type: f.type,
        severity: f.severity,
        title: String(f.title),
        description: String(f.description),
        ...(f.file != null ? { file: String(f.file) } : {}),
        ...(typeof f.line === 'number' ? { line: f.line } : {}),
        ...(f.suggestion != null ? { suggestion: String(f.suggestion) } : {}),
        ...(f.fingerprint != null ? { fingerprint: String(f.fingerprint) } : {}),
      }));

    const riskScore = Math.max(
      0,
      Math.min(100, Math.round(typeof parsed.riskScore === 'number' ? parsed.riskScore : 50))
    );

    return { findings, riskScore };
  } catch {
    return { findings: [], riskScore: 50 };
  }
}

export function registerDemoRoutes(app: FastifyInstance): void {
  const isDemoEnabled = getConfigOptional('DEMO_ENABLED') === 'true';
  const demoRateLimitMax = Number.parseInt(process.env.DEMO_RATE_LIMIT_PER_HOUR ?? '5', 10);
  const maxDiffBytes = parseInt(process.env.DEMO_MAX_DIFF_BYTES ?? '51200', 10);
  const demoTimeoutMs = 60_000;

  let llmProvider: LLMProvider | null = null;
  function getLLM(): LLMProvider {
    if (!llmProvider) {
      llmProvider = createLLMProvider();
    }
    return llmProvider;
  }

  app.get('/demo/samples', async (_req, reply) => {
    if (!isDemoEnabled) {
      return reply.status(404).send({ error: 'Demo not enabled' });
    }

    return reply.send(
      DEMO_SAMPLES.map((sample) => ({
        name: sample.name,
        description: sample.description,
        diffLineCount: sample.diff.split('\n').length,
      }))
    );
  });

  app.get<{ Params: { name: string } }>('/demo/samples/:name', async (req, reply) => {
    if (!isDemoEnabled) {
      return reply.status(404).send({ error: 'Demo not enabled' });
    }

    const sample = DEMO_SAMPLES.find((s) => s.name === req.params.name);
    if (!sample) {
      return reply.status(404).send({ error: 'Sample not found' });
    }

    return reply.send({ ...sample.result, diff: sample.diff });
  });

  app.post<{ Body: { diff?: string; prTitle?: string } }>(
    '/demo/analyze',
    {
      config: {
        rateLimit: {
          max: Number.isNaN(demoRateLimitMax) || demoRateLimitMax <= 0 ? 5 : demoRateLimitMax,
          timeWindow: '1 hour',
          keyGenerator: (request: FastifyRequest) => {
            const realIp = request.headers['x-real-ip'];
            return typeof realIp === 'string' && realIp.length > 0 ? realIp : request.ip;
          },
        },
      },
    },
    async (
      req: FastifyRequest<{ Body: { diff?: string; prTitle?: string } }>,
      reply: FastifyReply
    ) => {
      if (!isDemoEnabled) {
        return reply.status(404).send({ error: 'Demo not enabled' });
      }

      const { diff, prTitle = 'Demo PR' } = req.body ?? {};
      if (!diff || typeof diff !== 'string') {
        return reply.status(400).send({ error: 'Missing required field: diff' });
      }

      const diffBytes = Buffer.byteLength(diff, 'utf8');
      if (diffBytes > maxDiffBytes) {
        return reply.status(413).send({
          error: 'Diff too large',
          message: `Maximum diff size is ${maxDiffBytes} bytes (${Math.round(maxDiffBytes / 1024)}KB). Received ${diffBytes} bytes.`,
          maxBytes: maxDiffBytes,
          receivedBytes: diffBytes,
        });
      }

      const startTime = Date.now();
      const llm = getLLM();
      const agentTypes = ['architecture', 'security', 'performance', 'style'];

      const agentPromise = Promise.allSettled(
        agentTypes.map((agentType) => runAgent(llm, agentType, diff, prTitle))
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Analysis timed out')), demoTimeoutMs);
      });

      let agentSettledResults: PromiseSettledResult<AgentRunResult>[];
      try {
        agentSettledResults = await Promise.race([agentPromise, timeoutPromise]);
      } catch {
        return reply.status(504).send({ error: 'Analysis timed out after 60 seconds' });
      }

      const completedResults = agentSettledResults
        .filter((r): r is PromiseFulfilledResult<AgentRunResult> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((r) => r.status === 'completed');

      if (completedResults.length === 0) {
        return reply.status(500).send({ error: 'All analysis agents failed' });
      }

      const allFindings = completedResults.flatMap((r) => r.findings);
      const dedupedFindings = deduplicateFindings(allFindings);

      const activeWeights: Record<string, number> = {};
      for (const result of completedResults) {
        if (BASE_WEIGHTS[result.agentType] !== undefined) {
          activeWeights[result.agentType] = BASE_WEIGHTS[result.agentType];
        }
      }

      const totalWeight = Object.values(activeWeights).reduce((sum, current) => sum + current, 0);
      const finalRiskScore = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            completedResults.reduce(
              (sum, result) =>
                sum +
                result.riskScore *
                  (totalWeight > 0 ? (activeWeights[result.agentType] ?? 0) / totalWeight : 0),
              0
            )
          )
        )
      );

      let summary = '';
      if (dedupedFindings.length > 0) {
        try {
          const summaryInput = dedupedFindings
            .map((f) => `[${f.severity.toUpperCase()}] ${f.type}: ${f.title} - ${f.description}`)
            .join('\n');

          const summaryResponse = await llm.chat({
            model: 'claude-haiku-4-5-20251001',
            maxTokens: 300,
            systemPrompt:
              'Given these code review findings, write a 2-3 sentence summary of the most important issues for the PR author. Be direct and specific.',
            userMessage: summaryInput,
            temperature: 0.3,
          });

          summary = summaryResponse.text;
        } catch {
          // Best-effort summary generation.
        }
      }

      const agentResults: Record<
        string,
        { findingsCount: number; riskScore: number; status: string }
      > = {};
      for (const agentType of agentTypes) {
        const result = completedResults.find((x) => x.agentType === agentType);
        agentResults[agentType] = result
          ? {
              findingsCount: result.findings.length,
              riskScore: result.riskScore,
              status: 'completed',
            }
          : { findingsCount: 0, riskScore: 0, status: 'failed' };
      }

      return reply.send({
        riskScore: finalRiskScore,
        findings: dedupedFindings,
        agentResults,
        summary,
        processingTimeMs: Date.now() - startTime,
      });
    }
  );
}
