import { processCalibrationJob } from '../src/processors/calibration';
import type { Job } from 'bullmq';
import { resolveSignalWeights } from '@pullmint/shared/signal-weights';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
    calibrations: {},
    signalWeightDefaults: {},
  },
}));

jest.mock('@pullmint/shared/schemas', () => ({
  CheckpointRecordSchema: {
    pick: jest.fn(() => ({
      safeParse: jest.fn((cp: unknown) => {
        if (typeof cp === 'object' && cp !== null && 'type' in cp) {
          return { success: true, data: cp };
        }
        return { success: false };
      }),
    })),
  },
}));

jest.mock('@pullmint/shared/signal-weights', () => ({
  resolveSignalWeights: jest.fn(),
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

jest.mock('../src/processors/signal-recalibration', () => ({
  processSignalRecalibration: jest.fn().mockResolvedValue(undefined),
}));

// ---- shared mock DB state per test ----
let mockDb: {
  select: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
  transaction: jest.Mock;
};
let mockTx: { update: jest.Mock; insert: jest.Mock };
let mockLimit: jest.Mock;

function buildMockDb() {
  mockLimit = jest.fn().mockResolvedValue([]);

  const createUpdateChain = () => ({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  });

  const createInsertChain = () => ({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockResolvedValue([]),
      onConflictDoUpdate: jest.fn().mockResolvedValue([]),
    }),
  });

  mockTx = {
    update: jest.fn().mockImplementation(createUpdateChain),
    insert: jest.fn().mockImplementation(createInsertChain),
  };

  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: mockLimit }),
      }),
    }),
    update: jest.fn().mockImplementation(createUpdateChain),
    insert: jest.fn().mockImplementation(createInsertChain),
    transaction: jest.fn().mockImplementation(async (cb: (tx: typeof mockTx) => Promise<void>) => {
      await cb(mockTx);
    }),
  };
}

function setSelectResults(...results: unknown[]) {
  mockLimit.mockReset();
  mockLimit.mockResolvedValue([]);
  for (const result of results) {
    mockLimit.mockResolvedValueOnce(result);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
  (resolveSignalWeights as jest.Mock).mockResolvedValue({});
});

function makeConfirmedJob(executionId = 'exec-1'): Job {
  return {
    name: 'execution.confirmed',
    data: {
      executionId,
      repoFullName: 'org/repo',
      prNumber: 1,
      confirmedWithLowConfidence: false,
      finalRiskScore: 25,
      confirmedAt: Date.now(),
    },
  } as unknown as Job;
}

function makeRolledBackJob(executionId = 'exec-1'): Job {
  return {
    name: 'execution.rolled-back',
    data: {
      executionId,
      repoFullName: 'org/repo',
      prNumber: 1,
      rollbackSource: 'monitor',
      rolledBackAt: Date.now(),
    },
  } as unknown as Job;
}

function makeAnalysisCheckpoint(
  decision: 'approved' | 'held' | 'rollback',
  signals: Array<{
    signalType:
      | 'ci.result'
      | 'ci.coverage'
      | 'production.error_rate'
      | 'production.latency'
      | 'time_of_day'
      | 'author_history'
      | 'simultaneous_deploy'
      | 'deployment.status';
    value: number | boolean;
  }>
) {
  return {
    type: 'analysis',
    decision,
    score: 25,
    confidence: 0.9,
    missingSignals: [],
    signals: signals.map((s) => ({
      ...s,
      source: 'test',
      timestamp: Date.UTC(2026, 0, 2, 13, 0, 0),
    })),
    reason: 'test checkpoint',
    evaluatedAt: Date.now(),
  };
}

describe('processCalibrationJob', () => {
  it('returns early when execution is not found', async () => {
    setSelectResults([]); // execution not found
    await processCalibrationJob(makeConfirmedJob());
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('routes signal.recalibration jobs to signal-recalibration processor', async () => {
    const { processSignalRecalibration } = jest.requireMock(
      '../src/processors/signal-recalibration'
    ) as {
      processSignalRecalibration: jest.Mock;
    };

    await processCalibrationJob({ name: 'signal.recalibration', data: { scheduled: true } } as Job);

    expect(processSignalRecalibration).toHaveBeenCalledTimes(1);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('updates repo signal weights with EMA on rollback (present signals increase)', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
      { signalType: 'time_of_day', value: Date.UTC(2026, 0, 2, 13, 0, 0) },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 15, time_of_day: 5 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15, time_of_day: 5 });

    await processCalibrationJob(makeRolledBackJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['ci.result']).toBeCloseTo(15.1125, 6);
    expect(set.signalWeights.time_of_day).toBeGreaterThan(5);
  });

  it('updates repo signal weights with EMA on false-positive (held then confirmed decreases)', async () => {
    const checkpoint = makeAnalysisCheckpoint('held', [{ signalType: 'ci.result', value: false }]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 15 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15 });

    await processCalibrationJob(makeConfirmedJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['ci.result']).toBeCloseTo(14.8875, 6);
  });

  it('keeps signal weight unchanged on approved + confirmed', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 15 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15 });

    await processCalibrationJob(makeConfirmedJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['ci.result']).toBeCloseTo(15, 6);
  });

  it('appends outcome log entry with signalsPresent, rollback, analysisDecision, timestamp', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);

    const existingEntry = {
      signalsPresent: ['time_of_day'],
      rollback: false,
      analysisDecision: 'approved',
      timestamp: 1000,
    };

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [existingEntry],
        },
      ],
      [{ weights: { 'ci.result': 15 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15 });

    await processCalibrationJob(makeRolledBackJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.outcomeLog).toHaveLength(2);
    expect(set.outcomeLog[1].signalsPresent).toEqual(['ci.result']);
    expect(set.outcomeLog[1].rollback).toBe(true);
    expect(set.outcomeLog[1].analysisDecision).toBe('approved');
    expect(typeof set.outcomeLog[1].timestamp).toBe('number');
  });

  it('trims outcome log to 200 entries when appending', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);
    const existingLog = Array.from({ length: 200 }, (_, i) => ({
      signalsPresent: ['ci.result'],
      rollback: false,
      analysisDecision: 'approved' as const,
      timestamp: i + 1,
    }));

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: existingLog,
        },
      ],
      [{ weights: { 'ci.result': 15 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15 });

    await processCalibrationJob(makeRolledBackJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.outcomeLog).toHaveLength(200);
    expect(set.outcomeLog[0].timestamp).toBe(2);
  });

  it('upserts global baseline weights when signals are present', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 15 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 15 });

    await processCalibrationJob(makeRolledBackJob());

    expect(mockTx.insert).toHaveBeenCalledTimes(1);
    const insertChain = mockTx.insert.mock.results[0]?.value;
    const valuesArg = insertChain.values.mock.calls[0]?.[0];
    expect(valuesArg.id).toBe('global');
    expect(valuesArg.weights['ci.result']).toBeGreaterThan(15);
    expect(insertChain.values.mock.results[0]?.value.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('clamps updated weight to at most 3x hardcoded default', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 50 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 50 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({ 'ci.result': 50 });

    await processCalibrationJob(makeRolledBackJob()); // rolled-back = not confirmed

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['ci.result']).toBe(45);
  });

  it('does not update weights for signals absent from the checkpoint', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: false },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15, 'production.error_rate': 20 },
          outcomeLog: [],
        },
      ],
      [{ weights: { 'ci.result': 15, 'production.error_rate': 20 } }]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({
      'ci.result': 15,
      'production.error_rate': 20,
    });

    await processCalibrationJob(makeConfirmedJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['production.error_rate']).toBe(20);
    expect(set.signalWeights['ci.result']).toBe(15);
  });

  it('updates all threshold-matched signal types and ignores unsupported signal types', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.coverage', value: -11 },
      { signalType: 'production.error_rate', value: 11 },
      { signalType: 'production.latency', value: 21 },
      { signalType: 'time_of_day', value: Date.UTC(2026, 0, 2, 13, 0, 0) },
      { signalType: 'author_history', value: 0.3 },
      { signalType: 'simultaneous_deploy', value: true },
      { signalType: 'deployment.status', value: true },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: {},
          outcomeLog: [],
        },
      ],
      [
        {
          weights: {
            'ci.coverage': 10,
            'production.error_rate': 20,
            'production.latency': 10,
            time_of_day: 5,
            author_history: 10,
            simultaneous_deploy: 8,
            'deployment.status': 0,
          },
        },
      ]
    );

    (resolveSignalWeights as jest.Mock).mockResolvedValue({
      'ci.coverage': 10,
      'production.error_rate': 20,
      'production.latency': 10,
      time_of_day: 5,
      author_history: 10,
      simultaneous_deploy: 8,
      'deployment.status': 0,
    });

    await processCalibrationJob(makeRolledBackJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights['ci.coverage']).toBeGreaterThan(10);
    expect(set.signalWeights['production.error_rate']).toBeGreaterThan(20);
    expect(set.signalWeights['production.latency']).toBeGreaterThan(10);
    expect(set.signalWeights.time_of_day).toBeGreaterThan(5);
    expect(set.signalWeights.author_history).toBeGreaterThan(10);
    expect(set.signalWeights.simultaneous_deploy).toBeGreaterThan(8);
    expect(set.signalWeights['deployment.status']).toBeUndefined();
    expect(set.outcomeLog[0].signalsPresent).toEqual([
      'ci.coverage',
      'production.error_rate',
      'production.latency',
      'time_of_day',
      'author_history',
      'simultaneous_deploy',
    ]);
  });

  it('skips signal-weight updates and global upsert when no signal thresholds are met', async () => {
    const checkpoint = makeAnalysisCheckpoint('approved', [
      { signalType: 'ci.result', value: true },
      { signalType: 'ci.coverage', value: -5 },
      { signalType: 'production.error_rate', value: 3 },
      { signalType: 'production.latency', value: 10 },
      { signalType: 'time_of_day', value: Date.UTC(2026, 0, 5, 9, 0, 0) },
      { signalType: 'author_history', value: 0.1 },
      { signalType: 'simultaneous_deploy', value: false },
    ]);

    setSelectResults(
      [{ checkpoints: [checkpoint] }],
      [
        {
          repoFullName: 'org/repo',
          observationsCount: 20,
          calibrationFactor: 1,
          signalWeights: { 'ci.result': 15 },
          outcomeLog: [],
        },
      ]
    );

    await processCalibrationJob(makeConfirmedJob());

    const set = mockTx.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(set.signalWeights).toBeUndefined();
    expect(set.outcomeLog[0].signalsPresent).toEqual([]);
    expect(mockTx.insert).not.toHaveBeenCalled();
    expect(resolveSignalWeights).not.toHaveBeenCalled();
  });
});
