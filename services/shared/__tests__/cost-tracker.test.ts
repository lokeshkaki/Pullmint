jest.mock('../db', () => ({
  getDb: jest.fn(),
  schema: {
    tokenUsage: {
      executionId: 'execution_id',
      repoFullName: 'repo_full_name',
      agentType: 'agent_type',
      model: 'model',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      estimatedCostUsd: 'estimated_cost_usd',
      createdAt: 'created_at',
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  sql: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  eq: jest.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
  and: jest.fn((...conditions: unknown[]) => conditions),
}));

import { MODEL_PRICING, checkBudget, estimateCost, recordTokenUsage } from '../cost-tracker';

describe('estimateCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBe(0);
  });

  it('computes cost correctly for claude-sonnet-4-6', () => {
    const cost = estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 5);
  });

  it('computes cost correctly for claude-haiku-4-5-20251001', () => {
    const cost = estimateCost('claude-haiku-4-5-20251001', 500_000, 100_000);
    expect(cost).toBeCloseTo(0.8, 5);
  });

  it('uses fallback pricing for unknown models', () => {
    const cost = estimateCost('some-unknown-model-xyz', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6, 5);
  });

  it('all known models have defined pricing', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      const pricing = MODEL_PRICING[model];
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });
});

describe('recordTokenUsage', () => {
  let mockInsert: jest.Mock;
  let mockDb: { insert: jest.Mock };

  beforeEach(() => {
    mockInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
    mockDb = { insert: mockInsert };
  });

  it('inserts a row with computed cost', async () => {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: valuesMock });

    await recordTokenUsage(mockDb as never, {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      agentType: 'architecture',
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.executionId).toBe('exec-1');
    expect(insertedValues.agentType).toBe('architecture');
    expect(insertedValues.inputTokens).toBe(1000);
    expect(insertedValues.outputTokens).toBe(500);
    expect(insertedValues.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('swallows errors and never throws', async () => {
    mockInsert.mockReturnValue({ values: jest.fn().mockRejectedValue(new Error('DB error')) });

    await expect(
      recordTokenUsage(mockDb as never, {
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        agentType: 'architecture',
        model: 'claude-sonnet-4-6',
        inputTokens: 1000,
        outputTokens: 500,
      })
    ).resolves.not.toThrow();
  });
});

describe('checkBudget', () => {
  let mockDb: { select: jest.Mock };

  beforeEach(() => {
    const mockSummaryResult = [
      { totalCostUsd: 42.5, totalInputTokens: 10000, totalOutputTokens: 5000, callCount: 12 },
    ];

    mockDb = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockSummaryResult),
        }),
      }),
    };
  });

  it('returns allowed=true when no budget is set', async () => {
    const result = await checkBudget(mockDb as never, 'org/repo', 0);
    expect(result.allowed).toBe(true);
    expect(result.budgetUsd).toBe(0);
  });

  it('returns allowed=false when used >= budget', async () => {
    const result = await checkBudget(mockDb as never, 'org/repo', 40);
    expect(result.allowed).toBe(false);
    expect(result.usedUsd).toBeCloseTo(42.5);
    expect(result.remainingUsd).toBe(0);
  });

  it('returns allowed=true when under budget', async () => {
    const result = await checkBudget(mockDb as never, 'org/repo', 100);
    expect(result.allowed).toBe(true);
    expect(result.remainingUsd).toBeCloseTo(57.5);
  });
});
