// benchmarks/src/pipeline.bench.ts
import { registerSuite } from './harness';
import { generateDiff, generateFindings } from './generators';
import { parseDiff, filterDiff } from '../../services/shared/diff-filter';
import { deduplicateFindings } from '../../services/shared/dedup';
import { evaluateRisk } from '../../services/shared/risk-evaluator';
import { DEFAULT_SIGNAL_WEIGHTS } from '../../services/shared/signal-weights';
import type { Finding } from '../../services/shared/types';

/** Mock LLM that returns after configurable delay */
async function mockLLMCall(
  delayMs: number
): Promise<{ findings: Finding[]; riskScore: number }> {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    findings: generateFindings(8, { withFiles: true }),
    riskScore: Math.floor(Math.random() * 70) + 15,
  };
}

/** Simulates the full analysis pipeline for one PR */
async function runPipeline(llmDelayMs: number): Promise<void> {
  // Step 1: Parse diff (simulates dispatcher work)
  const raw = generateDiff(25, 20);
  const parsed = parseDiff(raw);

  // Step 2: Run 4 agents in parallel (simulates BullMQ parallel execution)
  const agentTypes = ['architecture', 'security', 'performance', 'style'];
  const agentResults = await Promise.all(
    agentTypes.map(async (agentType) => {
      const filtered = filterDiff(parsed, agentType, 100_000);
      const result = await mockLLMCall(llmDelayMs);
      return { agentType, ...result, filteredChars: filtered.diff.length };
    })
  );

  // Step 3: Synthesis — collect, dedup, score
  const allFindings = agentResults.flatMap((r) => r.findings);
  const dedupedFindings = deduplicateFindings(allFindings);

  const avgRiskScore =
    agentResults.reduce((sum, r) => sum + r.riskScore, 0) / agentResults.length;

  const evaluation = evaluateRisk({
    llmBaseScore: avgRiskScore,
    signals: [],
    calibrationFactor: 1.0,
    blastRadiusMultiplier: 1.0,
    signalWeights: DEFAULT_SIGNAL_WEIGHTS,
  });

  // Step 4: Build review payload (simulates github-integration work)
  const _ = {
    riskScore: evaluation.score,
    findingsCount: dedupedFindings.length,
    inlineComments: dedupedFindings.filter((f) => f.file && f.line).length,
  };
  void _;
}

registerSuite({
  name: 'pipeline-e2e',
  iterations: 20, // fewer iterations since this measures multi-step timing
  tasks: [
    {
      name: 'full pipeline — 0ms LLM delay (infrastructure overhead only)',
      tags: ['cpu'],
      fn: async () => {
        await runPipeline(0);
      },
    },
    {
      name: 'full pipeline — 100ms LLM delay (fast model simulation)',
      tags: ['cpu'],
      fn: async () => {
        await runPipeline(100);
      },
    },
    {
      name: 'full pipeline — 500ms LLM delay (realistic Haiku)',
      tags: ['cpu'],
      fn: async () => {
        await runPipeline(500);
      },
    },
    {
      name: 'full pipeline — 5000ms LLM delay (Sonnet under load)',
      tags: ['cpu'],
      fn: async () => {
        await runPipeline(5000);
      },
    },
  ],
});
