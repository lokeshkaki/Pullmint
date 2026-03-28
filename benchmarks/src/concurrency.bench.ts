// benchmarks/src/concurrency.bench.ts
import { registerSuite } from './harness';
import { generateDiff, generateFindings } from './generators';
import { parseDiff, filterDiff } from '../../services/shared/diff-filter';
import { deduplicateFindings } from '../../services/shared/dedup';
import { evaluateRisk } from '../../services/shared/risk-evaluator';

/** Simulates a single PR analysis (CPU work only, no I/O) */
async function analyzePR(delayMs = 0): Promise<void> {
  const raw = generateDiff(20, 20);
  const parsed = parseDiff(raw);

  const results = await Promise.all(
    ['architecture', 'security', 'performance', 'style'].map(
      async (agentType) => {
        const filtered = filterDiff(parsed, agentType, 100_000);
        if (delayMs > 0)
          await new Promise((r) => setTimeout(r, delayMs));
        return {
          findings: generateFindings(5, { withFiles: true }),
          riskScore: Math.random() * 60 + 20,
          chars: filtered.diff.length,
        };
      }
    )
  );

  const allFindings = results.flatMap((r) => r.findings);
  const deduped = deduplicateFindings(allFindings);
  const score = evaluateRisk({
    llmBaseScore: results.reduce((s, r) => s + r.riskScore, 0) / 4,
    signals: [],
    calibrationFactor: 1.0,
    blastRadiusMultiplier: 1.0,
  });
  void deduped;
  void score;
}

function runConcurrent(n: number, delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    void Promise.all(Array.from({ length: n }, () => analyzePR(delayMs))).then(
      () => {
        const elapsed = performance.now() - start;
        const throughput = ((n / (elapsed / 1000)) * 60).toFixed(0);
        process.stdout.write(
          `\n    ${n} concurrent: ${elapsed.toFixed(0)}ms total, ~${throughput} PRs/min\n`
        );
        resolve();
      }
    );
  });
}

registerSuite({
  name: 'concurrency',
  iterations: 5, // low iterations since each run involves N concurrent pipelines
  tasks: [
    {
      name: 'concurrency — 1 PR (baseline)',
      tags: ['cpu'],
      fn: async () => {
        await runConcurrent(1);
      },
    },
    {
      name: 'concurrency — 5 PRs simultaneous',
      tags: ['cpu'],
      fn: async () => {
        await runConcurrent(5);
      },
    },
    {
      name: 'concurrency — 10 PRs simultaneous',
      tags: ['cpu'],
      fn: async () => {
        await runConcurrent(10);
      },
    },
    {
      name: 'concurrency — 25 PRs simultaneous',
      tags: ['cpu'],
      fn: async () => {
        await runConcurrent(25);
      },
    },
    {
      name: 'concurrency — 50 PRs simultaneous',
      tags: ['cpu'],
      fn: async () => {
        await runConcurrent(50);
      },
    },
  ],
});
