// benchmarks/src/memory.bench.ts
import { registerSuite } from './harness';
import { generateDiff, generateFindings } from './generators';
import { parseDiff } from '../../services/shared/diff-filter';
import { deduplicateFindings } from '../../services/shared/dedup';

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function rssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

registerSuite({
  name: 'memory',
  iterations: 10,
  tasks: [
    {
      name: 'memory — parse 10MB diff (peak heap)',
      tags: ['cpu'],
      fn: () => {
        const before = heapMB();
        // 10MB diff: ~1000 files x 50 lines
        const raw = generateDiff(1000, 50);
        const parsed = parseDiff(raw);
        const after = heapMB();
        const peakDeltaMB = after - before;
        // Log for report generation
        process.stdout.write(
          `\n    heap delta for 10MB diff parse: ${peakDeltaMB.toFixed(1)}MB, files: ${parsed.totalFiles}\n`
        );
        void parsed;
      },
    },
    {
      name: 'memory — hold 1000 findings in memory',
      tags: ['cpu'],
      fn: () => {
        const before = heapMB();
        const findings = generateFindings(1000, { withFiles: true });
        const after = heapMB();
        process.stdout.write(
          `\n    heap delta for 1000 findings: ${(after - before).toFixed(1)}MB\n`
        );
        void findings;
      },
    },
    {
      name: 'memory — dedup 200 findings (peak during O(n²))',
      tags: ['cpu'],
      fn: () => {
        const findings = generateFindings(200, {
          withFiles: true,
          duplicateRate: 0.3,
        });
        const before = heapMB();
        const result = deduplicateFindings(findings);
        const after = heapMB();
        process.stdout.write(
          `\n    heap delta for dedup 200: ${(after - before).toFixed(2)}MB, result count: ${result.length}\n`
        );
      },
    },
    {
      name: 'memory — rss baseline (no workload)',
      tags: ['cpu'],
      fn: () => {
        process.stdout.write(
          `\n    RSS: ${rssMB().toFixed(1)}MB, heap: ${heapMB().toFixed(1)}MB\n`
        );
      },
    },
  ],
});
