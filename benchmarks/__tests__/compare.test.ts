import { compareResults } from '../src/compare';

const makeRun = (
  results: Array<{ suite: string; task: string; mean: number; p99: number }>
) => ({
  runAt: new Date().toISOString(),
  results,
});

describe('compareResults', () => {
  const baseline = makeRun([
    { suite: 'diff', task: 'parse-small', mean: 1.0, p99: 2.0 },
    { suite: 'diff', task: 'parse-large', mean: 10.0, p99: 20.0 },
    { suite: 'risk', task: 'evaluate', mean: 5.0, p99: 8.0 },
  ]);

  it('detects regression when current is >10% slower', () => {
    const current = makeRun([
      { suite: 'diff', task: 'parse-small', mean: 1.15, p99: 2.2 }, // +15%
      { suite: 'diff', task: 'parse-large', mean: 10.0, p99: 20.0 }, // stable
      { suite: 'risk', task: 'evaluate', mean: 5.0, p99: 8.0 }, // stable
    ]);
    const comparisons = compareResults(baseline, current);
    const regression = comparisons.find((c) => c.task === 'parse-small');
    expect(regression?.status).toBe('regression');
  });

  it('detects improvement when current is >10% faster', () => {
    const current = makeRun([
      { suite: 'diff', task: 'parse-small', mean: 1.0, p99: 2.0 }, // stable
      { suite: 'diff', task: 'parse-large', mean: 8.5, p99: 17.0 }, // -15%
      { suite: 'risk', task: 'evaluate', mean: 5.0, p99: 8.0 }, // stable
    ]);
    const comparisons = compareResults(baseline, current);
    const improvement = comparisons.find((c) => c.task === 'parse-large');
    expect(improvement?.status).toBe('improvement');
  });

  it('marks tasks within ±10% as stable', () => {
    const current = makeRun([
      { suite: 'diff', task: 'parse-small', mean: 1.05, p99: 2.0 }, // +5%
      { suite: 'diff', task: 'parse-large', mean: 9.6, p99: 19.5 }, // -4%
      { suite: 'risk', task: 'evaluate', mean: 5.0, p99: 8.0 }, // 0%
    ]);
    const comparisons = compareResults(baseline, current);
    for (const c of comparisons) {
      expect(c.status).toBe('stable');
    }
  });

  it('skips tasks not present in baseline', () => {
    const current = makeRun([
      { suite: 'diff', task: 'parse-small', mean: 1.0, p99: 2.0 },
      { suite: 'diff', task: 'new-task', mean: 3.0, p99: 5.0 }, // not in baseline
    ]);
    const comparisons = compareResults(baseline, current);
    const newTask = comparisons.find((c) => c.task === 'new-task');
    expect(newTask).toBeUndefined();
  });

  it('computes deltaPercent correctly', () => {
    const current = makeRun([
      { suite: 'diff', task: 'parse-small', mean: 1.2, p99: 2.0 }, // +20%
      { suite: 'diff', task: 'parse-large', mean: 10.0, p99: 20.0 },
      { suite: 'risk', task: 'evaluate', mean: 5.0, p99: 8.0 },
    ]);
    const comparisons = compareResults(baseline, current);
    const c = comparisons.find((c) => c.task === 'parse-small')!;
    expect(c.deltaPercent).toBeCloseTo(0.2, 5);
  });

  it('returns empty array when no common tasks', () => {
    const current = makeRun([
      { suite: 'other', task: 'totally-different', mean: 1.0, p99: 2.0 },
    ]);
    const comparisons = compareResults(baseline, current);
    expect(comparisons).toHaveLength(0);
  });
});
