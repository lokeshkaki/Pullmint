// benchmarks/src/harness.ts
import { Bench } from 'tinybench';
import { globSync } from 'glob';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface BenchmarkTask {
  name: string;
  fn: () => void | Promise<void>;
  /** Optional setup run once before all iterations */
  setup?: () => void | Promise<void>;
  /** Tag this task as 'cpu' or 'io' for --filter support */
  tags?: Array<'cpu' | 'io'>;
}

export interface BenchmarkSuite {
  name: string;
  tasks: BenchmarkTask[];
  iterations?: number; // default 100
}

interface TaskResult {
  suite: string;
  task: string;
  iterations: number;
  mean: number; // ms
  p50: number; // ms
  p75: number; // ms
  p95: number; // ms
  p99: number; // ms
  min: number; // ms
  max: number; // ms
  stddev: number;
  opsSec: number;
  tags: string[];
}

interface RunResults {
  runAt: string;
  systemInfo: SystemInfo;
  results: TaskResult[];
}

interface SystemInfo {
  os: string;
  cpu: string;
  ram: string;
  nodeVersion: string;
  arch: string;
}

const registeredSuites: BenchmarkSuite[] = [];

export function registerSuite(suite: BenchmarkSuite): void {
  registeredSuites.push(suite);
}

function getSystemInfo(): SystemInfo {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model ?? 'unknown',
    ram: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    nodeVersion: process.version,
    arch: os.arch(),
  };
}

function parseArgs(): {
  filter?: string;
  output: 'console' | 'json' | 'markdown';
  outfile?: string;
  iterations: number;
} {
  const args = process.argv.slice(2);
  const result = {
    output: 'console' as const,
    iterations: 100,
    filter: undefined as string | undefined,
    outfile: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]) result.filter = args[++i];
    if (args[i] === '--output' && args[i + 1]) result.output = args[++i] as typeof result.output;
    if (args[i] === '--outfile' && args[i + 1]) result.outfile = args[++i];
    if (args[i] === '--iterations' && args[i + 1]) result.iterations = parseInt(args[++i], 10);
  }

  return result;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatTable(results: TaskResult[]): string {
  const header = ['Suite', 'Task', 'Mean (ms)', 'p50', 'p95', 'p99', 'ops/sec'];
  const rows = results.map((r) => [
    r.suite,
    r.task,
    r.mean.toFixed(3),
    r.p50.toFixed(3),
    r.p95.toFixed(3),
    r.p99.toFixed(3),
    r.opsSec.toFixed(0),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = widths.map((w) => '-'.repeat(w)).join('-+-');
  const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join(' | ');

  return [fmt(header), line, ...rows.map(fmt)].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Discover and import all .bench.ts files
  const benchFiles = globSync('src/**/*.bench.ts', {
    cwd: path.resolve(__dirname, '..'),
  });
  for (const file of benchFiles) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(path.resolve(__dirname, '..', file.replace(/\.ts$/, '')));
  }

  const allResults: TaskResult[] = [];

  for (const suite of registeredSuites) {
    const iters = suite.iterations ?? args.iterations;
    const tasks = args.filter
      ? suite.tasks.filter((t) => (t.tags ?? ['cpu']).includes(args.filter as 'cpu' | 'io'))
      : suite.tasks;

    if (tasks.length === 0) continue;

    if (args.output === 'console') {
      process.stdout.write(`\nRunning suite: ${suite.name}\n`);
    }

    for (const task of tasks) {
      if (task.setup) await task.setup();

      const bench = new Bench({
        iterations: iters,
        warmupIterations: Math.min(10, Math.floor(iters / 10)),
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      bench.add(task.name, task.fn);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await bench.run();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const t = bench.tasks[0];
      if (!t?.result) continue;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      const samples = [...t.result.samples].sort((a, b) => a - b);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const mean = t.result.mean;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const sd = t.result.sd;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const hz = t.result.hz;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const minVal = t.result.min;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const maxVal = t.result.max;

      const result: TaskResult = {
        suite: suite.name,
        task: task.name,
        iterations: iters,
        mean,
        p50: samples.length ? percentile(samples, 50) : mean,
        p75: samples.length ? percentile(samples, 75) : mean,
        p95: samples.length ? percentile(samples, 95) : mean,
        p99: samples.length ? percentile(samples, 99) : mean,
        min: minVal,
        max: maxVal,
        stddev: sd,
        opsSec: hz,
        tags: task.tags ?? ['cpu'],
      };

      allResults.push(result);

      if (args.output === 'console') {
        process.stdout.write(
          `  ${task.name.padEnd(50)} mean=${result.mean.toFixed(3)}ms  p99=${result.p99.toFixed(3)}ms  ops/sec=${result.opsSec.toFixed(0)}\n`
        );
      }
    }
  }

  const runResults: RunResults = {
    runAt: new Date().toISOString(),
    systemInfo: getSystemInfo(),
    results: allResults,
  };

  if (args.output === 'json' || args.outfile) {
    const json = JSON.stringify(runResults, null, 2);
    if (args.outfile) {
      fs.mkdirSync(path.dirname(args.outfile), { recursive: true });
      fs.writeFileSync(args.outfile, json);
      process.stdout.write(`Results written to ${args.outfile}\n`);
    } else {
      process.stdout.write(json + '\n');
    }
  } else if (args.output === 'markdown') {
    process.stdout.write(`## Benchmark Results\n\n`);
    process.stdout.write(`Run at: ${runResults.runAt}\n\n`);
    process.stdout.write(
      `**System:** ${runResults.systemInfo.cpu}, ${runResults.systemInfo.ram} RAM, Node ${runResults.systemInfo.nodeVersion}\n\n`
    );
    process.stdout.write('```\n' + formatTable(allResults) + '\n```\n');
  } else if (args.output === 'console') {
    process.stdout.write('\n' + formatTable(allResults) + '\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
