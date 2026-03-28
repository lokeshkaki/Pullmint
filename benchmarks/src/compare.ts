// benchmarks/src/compare.ts
import * as fs from 'fs';
import * as path from 'path';

interface TaskResult {
  suite: string;
  task: string;
  mean: number;
  p99: number;
}

interface RunResults {
  runAt: string;
  results: TaskResult[];
}

interface Comparison {
  suite: string;
  task: string;
  baselineMean: number;
  currentMean: number;
  deltaPercent: number;
  status: 'regression' | 'improvement' | 'stable';
}

const REGRESSION_THRESHOLD = 0.1; // 10% slower
const IMPROVEMENT_THRESHOLD = 0.1; // 10% faster
const CI_FAIL_THRESHOLD = 0.15; // 15% slower fails CI

export function compareResults(baseline: RunResults, current: RunResults): Comparison[] {
  const baselineMap = new Map(baseline.results.map((r) => [`${r.suite}:${r.task}`, r]));
  const comparisons: Comparison[] = [];

  for (const curr of current.results) {
    const key = `${curr.suite}:${curr.task}`;
    const base = baselineMap.get(key);
    if (!base) continue; // new benchmark, no baseline

    const deltaPercent = (curr.mean - base.mean) / base.mean;
    let status: Comparison['status'] = 'stable';
    if (deltaPercent > REGRESSION_THRESHOLD) status = 'regression';
    else if (deltaPercent < -IMPROVEMENT_THRESHOLD) status = 'improvement';

    comparisons.push({
      suite: curr.suite,
      task: curr.task,
      baselineMean: base.mean,
      currentMean: curr.mean,
      deltaPercent,
      status,
    });
  }

  return comparisons;
}

function formatMarkdown(comparisons: Comparison[]): string {
  const regressions = comparisons.filter((c) => c.status === 'regression');
  const improvements = comparisons.filter((c) => c.status === 'improvement');

  const lines: string[] = ['## Benchmark Comparison', ''];

  if (regressions.length === 0 && improvements.length === 0) {
    lines.push('All benchmarks within ±10% of baseline. No significant changes.');
    return lines.join('\n');
  }

  if (regressions.length > 0) {
    lines.push('### Regressions (>10% slower)', '');
    lines.push('| Suite | Task | Baseline | Current | Delta |');
    lines.push('|---|---|---|---|---|');
    for (const c of regressions) {
      const delta = `+${(c.deltaPercent * 100).toFixed(1)}%`;
      const flag = c.deltaPercent > CI_FAIL_THRESHOLD ? ' ⚠️' : '';
      lines.push(
        `| ${c.suite} | ${c.task} | ${c.baselineMean.toFixed(3)}ms | ${c.currentMean.toFixed(3)}ms | ${delta}${flag} |`
      );
    }
    lines.push('');
  }

  if (improvements.length > 0) {
    lines.push('### Improvements (>10% faster)', '');
    lines.push('| Suite | Task | Baseline | Current | Delta |');
    lines.push('|---|---|---|---|---|');
    for (const c of improvements) {
      lines.push(
        `| ${c.suite} | ${c.task} | ${c.baselineMean.toFixed(3)}ms | ${c.currentMean.toFixed(3)}ms | ${(c.deltaPercent * 100).toFixed(1)}% |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: ts-node compare.ts <baseline.json> <current.json>');
    process.exit(1);
  }

  const baselinePath = path.resolve(args[0] ?? '');
  const currentPath = path.resolve(args[1] ?? '');

  if (!fs.existsSync(baselinePath)) {
    console.log(`Baseline file not found at ${baselinePath} — skipping comparison (first run)`);
    process.exit(0);
  }

  if (!fs.existsSync(currentPath)) {
    console.error(`Current results file not found at ${currentPath}`);
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const baseline: RunResults = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const current: RunResults = JSON.parse(fs.readFileSync(currentPath, 'utf8'));

  const comparisons = compareResults(baseline, current);
  const markdown = formatMarkdown(comparisons);

  console.log(markdown);

  // Exit with code 1 if any benchmark exceeds CI_FAIL_THRESHOLD
  const failingRegressions = comparisons.filter(
    (c) => c.status === 'regression' && c.deltaPercent > CI_FAIL_THRESHOLD
  );

  if (failingRegressions.length > 0) {
    console.error(`\nCI FAIL: ${failingRegressions.length} benchmark(s) regressed >15%:`);
    for (const r of failingRegressions) {
      console.error(`  - ${r.suite}/${r.task}: +${(r.deltaPercent * 100).toFixed(1)}%`);
    }
    process.exit(1);
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
