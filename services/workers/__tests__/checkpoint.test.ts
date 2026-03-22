jest.mock('@pullmint/shared/db', () => ({
  schema: {
    calibrations: {
      calibrationFactor: 'calibrationFactor',
      repoFullName: 'repoFullName',
    },
  },
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  retryWithBackoff: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('@pullmint/shared/risk-evaluator', () => ({
  evaluateRisk: jest.fn().mockReturnValue({
    score: 35,
    confidence: 0.85,
    missingSignals: [],
    reason: 'moderate risk',
  }),
}));

import { buildAnalysisCheckpoint } from '../src/checkpoint';

const mockOctokit = {
  rest: {
    checks: {
      listForRef: jest.fn().mockResolvedValue({
        data: { check_runs: [{ conclusion: 'success' }] },
      }),
    },
  },
};

const mockDb = {
  select: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([{ calibrationFactor: 1.2 }]),
      }),
    }),
  }),
};

const basePrEvent = {
  executionId: 'exec-1',
  prNumber: 42,
  repoFullName: 'org/repo',
  headSha: 'abc123',
  baseSha: 'def456',
  author: 'alice',
  title: 'feat: test',
  orgId: 'org-1',
};

describe('buildAnalysisCheckpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds checkpoint with CI signal and calibration factor', async () => {
    const result = await buildAnalysisCheckpoint(
      basePrEvent,
      45,
      ['org', 'repo'],
      mockOctokit as any,
      mockDb as any
    );

    expect(result.checkpoint1.type).toBe('analysis');
    expect(result.checkpoint1.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signalType: 'ci.result', value: true }),
        expect.objectContaining({ signalType: 'time_of_day' }),
      ])
    );
    expect(result.calibrationFactor).toBe(1.2);
  });

  it('omits CI signal when checks API fails', async () => {
    mockOctokit.rest.checks.listForRef.mockRejectedValueOnce(new Error('API error'));

    const result = await buildAnalysisCheckpoint(
      basePrEvent,
      45,
      ['org', 'repo'],
      mockOctokit as any,
      mockDb as any
    );

    // Should only have time_of_day signal
    expect(result.checkpoint1.signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ signalType: 'time_of_day' })])
    );
    expect(result.checkpoint1.signals.find((s) => s.signalType === 'ci.result')).toBeUndefined();
  });

  it('uses default calibration factor of 1.0 when no record exists', async () => {
    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await buildAnalysisCheckpoint(
      basePrEvent,
      45,
      ['org', 'repo'],
      mockOctokit as any,
      mockDb as any
    );

    expect(result.calibrationFactor).toBe(1.0);
  });

  it('sets decision to held when score >= 40', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValueOnce({
      score: 55,
      confidence: 0.9,
      missingSignals: [],
      reason: 'high risk',
    });

    const result = await buildAnalysisCheckpoint(
      basePrEvent,
      55,
      ['org', 'repo'],
      mockOctokit as any,
      mockDb as any
    );

    expect(result.checkpoint1.decision).toBe('held');
  });

  it('sets decision to approved when score < 40', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValueOnce({
      score: 25,
      confidence: 0.9,
      missingSignals: [],
      reason: 'low risk',
    });

    const result = await buildAnalysisCheckpoint(
      basePrEvent,
      25,
      ['org', 'repo'],
      mockOctokit as any,
      mockDb as any
    );

    expect(result.checkpoint1.decision).toBe('approved');
  });
});
