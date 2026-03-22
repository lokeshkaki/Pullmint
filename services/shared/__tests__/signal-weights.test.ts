import { resolveSignalWeights, DEFAULT_SIGNAL_WEIGHTS } from '../signal-weights';

// Mock the db module using relative path (signal-weights.ts imports './db')
// Only schema is needed at runtime; getDb is only used for the DrizzleDb type.
jest.mock('../db', () => ({
  getDb: jest.fn(),
  schema: {
    signalWeightDefaults: {
      id: 'id',
      weights: 'weights',
    },
    calibrations: {
      repoFullName: 'repo_full_name',
      signalWeights: 'signal_weights',
      observationsCount: 'observations_count',
    },
  },
}));

// Mock drizzle-orm eq function
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ field: a, value: b })),
}));

// ---- shared mock DB state per test ----
let mockLimit: jest.Mock;
let mockDb: { select: jest.Mock };

function buildMockDb() {
  mockLimit = jest.fn().mockResolvedValue([]);
  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: mockLimit }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
});

type TestDb = Parameters<typeof resolveSignalWeights>[1];

describe('DEFAULT_SIGNAL_WEIGHTS', () => {
  it('matches current risk-evaluator hardcoded values', () => {
    expect(DEFAULT_SIGNAL_WEIGHTS['ci.result']).toBe(15);
    expect(DEFAULT_SIGNAL_WEIGHTS['ci.coverage']).toBe(10);
    expect(DEFAULT_SIGNAL_WEIGHTS['production.error_rate']).toBe(20);
    expect(DEFAULT_SIGNAL_WEIGHTS['production.latency']).toBe(10);
    expect(DEFAULT_SIGNAL_WEIGHTS['time_of_day']).toBe(5);
    expect(DEFAULT_SIGNAL_WEIGHTS['author_history']).toBe(10);
    expect(DEFAULT_SIGNAL_WEIGHTS['simultaneous_deploy']).toBe(8);
    expect(DEFAULT_SIGNAL_WEIGHTS['deployment.status']).toBe(0);
  });
});

describe('resolveSignalWeights', () => {
  it('returns hardcoded defaults when no global baseline and no repo weights exist', async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    expect(result).toEqual(DEFAULT_SIGNAL_WEIGHTS);
  });

  it('global baseline overrides hardcoded defaults', async () => {
    mockLimit
      .mockResolvedValueOnce([{ weights: { 'ci.result': 20, 'ci.coverage': 12 } }])
      .mockResolvedValueOnce([]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    expect(result['ci.result']).toBe(20);
    expect(result['ci.coverage']).toBe(12);
    // All other signals remain at hardcoded defaults
    expect(result['production.error_rate']).toBe(DEFAULT_SIGNAL_WEIGHTS['production.error_rate']);
    expect(result['production.latency']).toBe(DEFAULT_SIGNAL_WEIGHTS['production.latency']);
    expect(result['time_of_day']).toBe(DEFAULT_SIGNAL_WEIGHTS['time_of_day']);
    expect(result['author_history']).toBe(DEFAULT_SIGNAL_WEIGHTS['author_history']);
    expect(result['simultaneous_deploy']).toBe(DEFAULT_SIGNAL_WEIGHTS['simultaneous_deploy']);
  });

  it('repo weights override global baseline when ≥10 observations', async () => {
    mockLimit
      .mockResolvedValueOnce([{ weights: { 'ci.result': 20 } }])
      .mockResolvedValueOnce([{ signalWeights: { 'ci.result': 25 }, observationsCount: 15 }]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    expect(result['ci.result']).toBe(25);
  });

  it('repo weights ignored when < 10 observations', async () => {
    mockLimit
      .mockResolvedValueOnce([{ weights: { 'ci.result': 20 } }])
      .mockResolvedValueOnce([{ signalWeights: { 'ci.result': 25 }, observationsCount: 5 }]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    // Global (20) used, repo (25) ignored due to low observation count
    expect(result['ci.result']).toBe(20);
  });

  it('repo weights ignored when signalWeights is null', async () => {
    mockLimit
      .mockResolvedValueOnce([{ weights: { 'ci.result': 20 } }])
      .mockResolvedValueOnce([{ signalWeights: null, observationsCount: 50 }]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    // null signalWeights — global baseline applies
    expect(result['ci.result']).toBe(20);
  });

  it('per-signal resolution — repo overrides only specific signals', async () => {
    mockLimit
      .mockResolvedValueOnce([{ weights: { 'ci.result': 18, 'ci.coverage': 12 } }])
      .mockResolvedValueOnce([{ signalWeights: { 'ci.result': 22 }, observationsCount: 20 }]);

    const result = await resolveSignalWeights('org/repo', mockDb as unknown as TestDb);

    expect(result['ci.result']).toBe(22); // from repo
    expect(result['ci.coverage']).toBe(12); // from global
    expect(result['production.error_rate']).toBe(20); // from hardcoded default
  });
});
