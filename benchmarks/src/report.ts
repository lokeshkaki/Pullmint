// benchmarks/src/report.ts
import * as fs from 'fs';
import * as path from 'path';

interface TaskResult {
  suite: string;
  task: string;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  opsSec: number;
  tags: string[];
}

interface RunResults {
  runAt: string;
  systemInfo: { os: string; cpu: string; ram: string; nodeVersion: string; arch: string };
  results: TaskResult[];
}

/** Unicode block sparkline: maps value in [min, max] to a block character */
function sparklineChar(value: number, min: number, max: number): string {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (max === min) return blocks[0];
  const idx = Math.min(
    blocks.length - 1,
    Math.floor(((value - min) / (max - min)) * blocks.length)
  );
  return blocks[idx];
}

function sparkline(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((v) => sparklineChar(v, min, max)).join('');
}

function formatTable(tasks: TaskResult[]): string {
  const header = '| Task | Mean (ms) | p50 | p95 | p99 | ops/sec |';
  const sep = '|---|---|---|---|---|---|';
  const rows = tasks.map(
    (t) =>
      `| ${t.task} | ${t.mean.toFixed(3)} | ${t.p50.toFixed(3)} | ${t.p95.toFixed(3)} | ${t.p99.toFixed(3)} | ${t.opsSec.toFixed(0)} |`
  );
  return [header, sep, ...rows].join('\n');
}

function generateInsights(results: TaskResult[]): string[] {
  const insights: string[] = [];

  const xlParse = results.find((r) => r.task.includes('parseDiff') && r.task.includes('XL'));
  if (xlParse) {
    insights.push(
      `Diff parsing handles 20,000 lines in ${xlParse.mean.toFixed(0)}ms mean (p99: ${xlParse.p99.toFixed(0)}ms)`
    );
  }

  const pipeline0 = results.find((r) => r.task.includes('0ms LLM'));
  if (pipeline0) {
    insights.push(
      `Pipeline infrastructure overhead: ${pipeline0.mean.toFixed(0)}ms — LLM calls dominate total latency`
    );
  }

  const dedup200 = results.find((r) => r.task.includes('200 findings'));
  if (dedup200) {
    insights.push(
      `Deduplication scales to 200 findings in ${dedup200.mean.toFixed(1)}ms (O(n²) algorithm, still fast in practice)`
    );
  }

  const riskEval = results.find(
    (r) => r.task.includes('evaluateRisk') && r.task.includes('7 signal')
  );
  if (riskEval) {
    insights.push(
      `Risk evaluation with all 7 signals: ${(riskEval.mean * 1000).toFixed(0)}μs — never a bottleneck`
    );
  }

  return insights;
}

function main(): void {
  const resultsDir = path.resolve(__dirname, '../results');
  const files = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json') && f !== 'baseline.json');

  if (files.length === 0) {
    console.error('No result files found in benchmarks/results/. Run benchmarks first.');
    process.exit(1);
  }

  // Use the most recent result file
  files.sort();
  const latest = JSON.parse(
    fs.readFileSync(path.join(resultsDir, files[files.length - 1]), 'utf8')
  ) as RunResults;

  const suites = [...new Set(latest.results.map((r) => r.suite))];

  const lines: string[] = [
    '# Pullmint Performance Benchmarks',
    '',
    `> Generated: ${latest.runAt}`,
    '',
    '## System',
    '',
    `- **OS:** ${latest.systemInfo.os}`,
    `- **CPU:** ${latest.systemInfo.cpu}`,
    `- **RAM:** ${latest.systemInfo.ram}`,
    `- **Node.js:** ${latest.systemInfo.nodeVersion}`,
    `- **Arch:** ${latest.systemInfo.arch}`,
    '',
    '## Key Takeaways',
    '',
    ...generateInsights(latest.results).map((i) => `- ${i}`),
    '',
  ];

  for (const suite of suites) {
    const tasks = latest.results.filter((r) => r.suite === suite);
    const means = tasks.map((t) => t.mean);
    const chart = sparkline(means);

    lines.push(`## ${suite}`);
    lines.push('');
    lines.push(`Latency distribution (mean): ${chart}`);
    lines.push('');
    lines.push(formatTable(tasks));
    lines.push('');
  }

  lines.push('## How to Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('cd benchmarks && npm install');
  lines.push('npm run benchmark        # CPU-bound benchmarks (no Docker needed)');
  lines.push('npm run benchmark:full   # All benchmarks (requires Docker services running)');
  lines.push('npm run report           # Regenerate this file');
  lines.push('```');

  const output = lines.join('\n');
  const outPath = path.resolve(__dirname, '../../benchmarks/RESULTS.md');
  fs.writeFileSync(outPath, output);
  console.log(`Report written to ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
