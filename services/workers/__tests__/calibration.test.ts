import { processCalibrationJob } from '../src/processors/calibration';
import type { Job } from 'bullmq';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
    calibrations: {},
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

// ---- shared mock DB state per test ----
let mockDb: { select: jest.Mock; update: jest.Mock; insert: jest.Mock };
let mockLimit: jest.Mock;
let mockReturning: jest.Mock;

function buildMockDb() {
  mockReturning = jest.fn().mockResolvedValue([]);
  mockLimit = jest.fn().mockResolvedValue([]);

  const makeWhereResult = () =>
    Object.assign(Promise.resolve(undefined) as Promise<unknown>, {
      returning: mockReturning,
      limit: mockLimit,
    });

  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: mockLimit }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(makeWhereResult),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        onConflictDoUpdate: jest.fn().mockReturnValue({ returning: mockReturning }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
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

describe('processCalibrationJob', () => {
  it('returns early when execution is not found', async () => {
    mockLimit.mockResolvedValue([]); // execution not found
    await processCalibrationJob(makeConfirmedJob());
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('increments successCount for execution.confirmed', async () => {
    // execution with analysis checkpoint approved
    mockLimit
      .mockResolvedValueOnce([
        {
          checkpoints: [
            {
              type: 'analysis',
              decision: 'approved',
              score: 25,
              confidence: 0.9,
              signals: [],
              missingSignals: [],
              reason: 'test',
              evaluatedAt: Date.now(),
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          repoFullName: 'org/repo',
          observationsCount: 5,
          calibrationFactor: 1.0,
          successCount: 3,
          rollbackCount: 1,
          falseNegativeCount: 0,
          falsePositiveCount: 0,
        },
      ]);

    await processCalibrationJob(makeConfirmedJob());

    expect(mockDb.update).toHaveBeenCalled();
    const updateSetArgs = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(updateSetArgs).toBeDefined();
  });

  it('increments rollbackCount for execution.rolled-back', async () => {
    mockLimit
      .mockResolvedValueOnce([
        {
          checkpoints: [
            {
              type: 'analysis',
              decision: 'approved',
              score: 25,
              confidence: 0.9,
              signals: [],
              missingSignals: [],
              reason: 'test',
              evaluatedAt: Date.now(),
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          repoFullName: 'org/repo',
          observationsCount: 5,
          calibrationFactor: 1.0,
          successCount: 3,
          rollbackCount: 1,
          falseNegativeCount: 0,
          falsePositiveCount: 0,
        },
      ]);

    await processCalibrationJob(makeRolledBackJob());

    expect(mockDb.update).toHaveBeenCalled();
  });

  it('adjusts calibrationFactor upward after MIN_OBSERVATIONS when false-negative detected', async () => {
    // False negative: analysis approved (decision=approved) but rolled back (not confirmed)
    mockLimit
      .mockResolvedValueOnce([
        {
          checkpoints: [
            {
              type: 'analysis',
              decision: 'approved',
              score: 25,
              confidence: 0.9,
              signals: [],
              missingSignals: [],
              reason: 'test',
              evaluatedAt: Date.now(),
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          repoFullName: 'org/repo',
          observationsCount: 15, // past MIN_OBSERVATIONS
          calibrationFactor: 1.0,
          successCount: 10,
          rollbackCount: 4,
          falseNegativeCount: 2,
          falsePositiveCount: 1,
        },
      ]);

    await processCalibrationJob(makeRolledBackJob()); // rolled-back = not confirmed

    expect(mockDb.update).toHaveBeenCalled();
    const set = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    // calibrationFactor should be a number (updated, since false negative path)
    expect(typeof set.calibrationFactor).toBe('number');
    expect(set.calibrationFactor).toBeGreaterThan(1.0);
  });

  it('adjusts calibrationFactor downward when false-positive detected', async () => {
    // False positive: analysis held (decision=held) but confirmed fine
    mockLimit
      .mockResolvedValueOnce([
        {
          checkpoints: [
            {
              type: 'analysis',
              decision: 'held',
              score: 70,
              confidence: 0.9,
              signals: [],
              missingSignals: [],
              reason: 'test',
              evaluatedAt: Date.now(),
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          repoFullName: 'org/repo',
          observationsCount: 15,
          calibrationFactor: 1.0,
          successCount: 10,
          rollbackCount: 2,
          falseNegativeCount: 1,
          falsePositiveCount: 3,
        },
      ]);

    await processCalibrationJob(makeConfirmedJob()); // confirmed = isConfirmed=true

    const set = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(typeof set.calibrationFactor).toBe('number');
    expect(set.calibrationFactor).toBeLessThan(1.0);
  });

  it('does not update calibrationFactor when below MIN_OBSERVATIONS threshold', async () => {
    mockLimit
      .mockResolvedValueOnce([
        {
          checkpoints: [
            {
              type: 'analysis',
              decision: 'approved',
              score: 30,
              confidence: 0.8,
              signals: [],
              missingSignals: [],
              reason: 'test',
              evaluatedAt: Date.now(),
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          repoFullName: 'org/repo',
          observationsCount: 3, // below MIN_OBSERVATIONS=10
          calibrationFactor: 1.0,
          successCount: 2,
          rollbackCount: 1,
          falseNegativeCount: 0,
          falsePositiveCount: 0,
        },
      ]);

    await processCalibrationJob(makeRolledBackJob());

    const set = mockDb.update.mock.results[0]?.value.set.mock.calls[0]?.[0];
    // calibrationFactor should NOT be a number (left as column ref since newFactor is undefined)
    expect(typeof set.calibrationFactor).not.toBe('number');
  });

  it('creates new calibration record if one does not exist yet', async () => {
    mockLimit
      .mockResolvedValueOnce([{ checkpoints: [] }]) // execution found, no analysis checkpoint
      .mockResolvedValueOnce([]); // no calibration record found after insert

    await processCalibrationJob(makeConfirmedJob());

    expect(mockDb.insert).toHaveBeenCalled();
  });
});
