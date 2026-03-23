import { processSignalRecalibration } from '../src/processors/signal-recalibration';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    calibrations: {},
    signalWeightDefaults: {},
  },
}));

jest.mock('@pullmint/shared/signal-weights', () => ({
  DEFAULT_SIGNAL_WEIGHTS: {
    'ci.result': 15,
    'ci.coverage': 10,
    'production.error_rate': 20,
    'production.latency': 10,
    time_of_day: 5,
    author_history: 10,
    simultaneous_deploy: 8,
    'deployment.status': 0,
  },
}));

let mockDb: {
  select: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
};
let mockSelectWhere: jest.Mock;
let updateSetCalls: Array<Record<string, unknown>>;
let insertValuesCalls: Array<Record<string, unknown>>;
let insertConflictCalls: Array<Record<string, unknown>>;

function buildMockDb() {
  updateSetCalls = [];
  insertValuesCalls = [];
  insertConflictCalls = [];

  mockSelectWhere = jest.fn().mockResolvedValue([]);

  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((setArg: Record<string, unknown>) => {
        updateSetCalls.push(setArg);
        return {
          where: jest.fn().mockResolvedValue(undefined),
        };
      }),
    })),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((valuesArg: Record<string, unknown>) => {
        insertValuesCalls.push(valuesArg);
        return {
          onConflictDoUpdate: jest
            .fn()
            .mockImplementation((conflictArg: Record<string, unknown>) => {
              insertConflictCalls.push(conflictArg);
              return Promise.resolve(undefined);
            }),
        };
      }),
    })),
  };
}

function makeOutcome(
  signalTypes: string[],
  rollback: boolean,
  analysisDecision: 'approved' | 'held',
  timestamp: number
) {
  return {
    signalsPresent: signalTypes,
    rollback,
    analysisDecision,
    timestamp,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
});

describe('processSignalRecalibration', () => {
  it('recomputes per-repo weights from outcome history', async () => {
    const repo1Outcomes = [
      makeOutcome(['ci.result'], true, 'approved', 1),
      makeOutcome(['ci.result'], true, 'approved', 2),
      makeOutcome(['ci.result'], true, 'approved', 3),
      makeOutcome(['ci.result'], true, 'approved', 4),
      makeOutcome(['ci.result'], true, 'approved', 5),
      makeOutcome(['ci.result'], true, 'approved', 6),
      makeOutcome(['ci.result'], false, 'approved', 7),
      makeOutcome(['ci.result'], false, 'approved', 8),
      makeOutcome([], false, 'approved', 9),
      makeOutcome([], false, 'approved', 10),
    ];

    const repo2Outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(['time_of_day'], i % 2 === 0, 'approved', i + 20)
    );

    mockSelectWhere.mockResolvedValue([
      { repoFullName: 'org/repo-1', outcomeLog: repo1Outcomes },
      { repoFullName: 'org/repo-2', outcomeLog: repo2Outcomes },
    ]);

    await processSignalRecalibration();

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(updateSetCalls[0]?.signalWeights).toBeDefined();
    const repo1Weights = updateSetCalls[0]?.signalWeights as Record<string, number>;
    expect(repo1Weights['ci.result']).toBeCloseTo(37.5, 6);
  });

  it('skips repos with fewer than 10 outcome log entries', async () => {
    mockSelectWhere.mockResolvedValue([
      {
        repoFullName: 'org/small-repo',
        outcomeLog: Array.from({ length: 5 }, (_, i) =>
          makeOutcome(['ci.result'], i % 2 === 0, 'approved', i + 1)
        ),
      },
    ]);

    await processSignalRecalibration();

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('recomputes global baseline from aggregate outcomes', async () => {
    const repo1Outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(['ci.result'], i < 7, 'approved', i + 1)
    );
    const repo2Outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(['ci.result'], i < 2, 'approved', i + 20)
    );

    mockSelectWhere.mockResolvedValue([
      { repoFullName: 'org/repo-1', outcomeLog: repo1Outcomes },
      { repoFullName: 'org/repo-2', outcomeLog: repo2Outcomes },
    ]);

    await processSignalRecalibration();

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(insertValuesCalls[0]?.id).toBe('global');
    expect(insertValuesCalls[0]?.observationsCount).toBe(20);
    expect(insertConflictCalls).toHaveLength(1);
  });

  it('trims outcome log to 200 entries', async () => {
    const largeOutcomeLog = Array.from({ length: 250 }, (_, i) =>
      makeOutcome(['ci.result'], i % 2 === 0, 'approved', i + 1)
    );

    mockSelectWhere.mockResolvedValue([{ repoFullName: 'org/repo', outcomeLog: largeOutcomeLog }]);

    await processSignalRecalibration();

    const setArg = updateSetCalls[0];
    const trimmed = setArg?.outcomeLog as Array<{ timestamp: number }>;
    expect(trimmed).toHaveLength(200);
    expect(trimmed[0]?.timestamp).toBe(51);
    expect(trimmed[199]?.timestamp).toBe(250);
  });

  it('computes signal impact using present vs absent rollback rates', async () => {
    const outcomes = [
      makeOutcome(['ci.coverage'], true, 'approved', 1),
      makeOutcome(['ci.coverage'], true, 'approved', 2),
      makeOutcome(['ci.coverage'], true, 'approved', 3),
      makeOutcome(['ci.coverage'], true, 'approved', 4),
      makeOutcome(['ci.coverage'], false, 'approved', 5),
      makeOutcome([], true, 'approved', 6),
      makeOutcome([], false, 'approved', 7),
      makeOutcome([], false, 'approved', 8),
      makeOutcome([], false, 'approved', 9),
      makeOutcome([], false, 'approved', 10),
    ];

    mockSelectWhere.mockResolvedValue([{ repoFullName: 'org/repo', outcomeLog: outcomes }]);

    await processSignalRecalibration();

    const setArg = updateSetCalls[0];
    const weights = setArg?.signalWeights as Record<string, number>;
    expect(weights['ci.coverage']).toBeCloseTo(22, 6);
  });

  it('clamps recomputed weight to [0, 3x default]', async () => {
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      makeOutcome(['ci.result'], true, 'approved', i + 1)
    );

    mockSelectWhere.mockResolvedValue([{ repoFullName: 'org/repo', outcomeLog: outcomes }]);

    await processSignalRecalibration();

    const setArg = updateSetCalls[0];
    const weights = setArg?.signalWeights as Record<string, number>;
    expect(weights['ci.result']).toBe(45);
    expect(weights['ci.result']).toBeLessThanOrEqual(45);
  });

  it('uses fallback default weight of 20 for unknown signal types', async () => {
    const outcomes = [
      makeOutcome(['custom.signal'], true, 'approved', 1),
      makeOutcome(['custom.signal'], true, 'approved', 2),
      makeOutcome(['custom.signal'], false, 'approved', 3),
      makeOutcome([], false, 'approved', 4),
      makeOutcome([], false, 'approved', 5),
      makeOutcome([], false, 'approved', 6),
      makeOutcome([], false, 'approved', 7),
      makeOutcome([], false, 'approved', 8),
      makeOutcome([], false, 'approved', 9),
      makeOutcome([], false, 'approved', 10),
    ];

    mockSelectWhere.mockResolvedValue([{ repoFullName: 'org/repo', outcomeLog: outcomes }]);

    await processSignalRecalibration();

    const setArg = updateSetCalls[0];
    const weights = setArg?.signalWeights as Record<string, number>;
    // present rollback rate = 2/3, absent rollback rate = 0/7 => impact = 0.666...
    // fallback default = 20 => 20 * (1 + 2 * 2/3) = 46.666...
    expect(weights['custom.signal']).toBeCloseTo(46.6666667, 6);
  });
});
