import { processDeploymentStatusJob } from '../src/processors/deployment-status';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    DEPLOYMENT: 'deployment',
    CALIBRATION: 'calibration',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/risk-evaluator', () => ({
  evaluateRisk: jest.fn().mockReturnValue({
    score: 20,
    confidence: 0.8,
    missingSignals: [],
    reason: 'test',
  }),
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

// ---- shared DB mock state ----
let mockDb: { select: jest.Mock; update: jest.Mock };
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
        limit: mockLimit,
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(makeWhereResult),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
  (
    jest.requireMock('@pullmint/shared/risk-evaluator') as { evaluateRisk: jest.Mock }
  ).evaluateRisk.mockReturnValue({
    score: 20,
    confidence: 0.8,
    missingSignals: [],
    reason: 'test',
  });
});

const NOW = Date.now();
const T6_AGO = new Date(NOW - 6 * 60 * 1000).toISOString(); // 6 min ago (past T+5)
const T35_AGO = new Date(NOW - 35 * 60 * 1000).toISOString(); // 35 min ago (past T+30)

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'exec-1',
    repoFullName: 'org/repo',
    prNumber: 1,
    status: 'monitoring',
    riskScore: 30,
    deploymentStartedAt: T6_AGO,
    checkpoints: [],
    signalsReceived: {},
    repoContext: null,
    metadata: {},
    ...overrides,
  };
}

describe('processDeploymentStatusJob', () => {
  it('does nothing when there are no monitoring executions', async () => {
    mockLimit.mockResolvedValue([]);
    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processDeploymentStatusJob();

    expect(addJob).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('writes T+5 checkpoint when execution is past 5 minutes', async () => {
    const execution = makeExecution({ deploymentStartedAt: T6_AGO, checkpoints: [] });
    mockLimit.mockResolvedValue([execution]);

    await processDeploymentStatusJob();

    expect(mockDb.update).toHaveBeenCalled();
  });

  it('skips checkpoint if it already exists for that type', async () => {
    // Already has a post-deploy-5 checkpoint
    const execution = makeExecution({
      deploymentStartedAt: T6_AGO,
      checkpoints: [
        {
          type: 'post-deploy-5',
          score: 20,
          confidence: 0.8,
          missingSignals: [],
          signals: [],
          decision: 'approved',
          reason: 'test',
          evaluatedAt: Date.now(),
        },
      ],
    });
    mockLimit.mockResolvedValue([execution]);

    await processDeploymentStatusJob();

    // Should not write another checkpoint of same type
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('triggers rollback for T+30 execution with high risk score', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValue({
      score: 75,
      confidence: 0.9,
      missingSignals: [],
      reason: 'high risk',
    });

    const execution = makeExecution({ deploymentStartedAt: T35_AGO, checkpoints: [] });
    mockLimit.mockResolvedValue([execution]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentStatusJob();

    expect(addJob).toHaveBeenCalledWith(
      'deployment',
      'deployment.rollback',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it('confirms execution for T+30 with low risk score', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValue({
      score: 20,
      confidence: 0.8,
      missingSignals: [],
      reason: 'low risk',
    });

    const execution = makeExecution({ deploymentStartedAt: T35_AGO, checkpoints: [] });
    mockLimit.mockResolvedValue([execution]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentStatusJob();

    expect(addJob).toHaveBeenCalledWith(
      'calibration',
      'execution.confirmed',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it('defers T+5 checkpoint when confidence is low', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValue({
      score: 60,
      confidence: 0.1,
      missingSignals: ['ci.result'],
      reason: 'low confidence',
    });

    const execution = makeExecution({ deploymentStartedAt: T6_AGO, checkpoints: [] });
    mockLimit.mockResolvedValue([execution]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentStatusJob();

    // T+5 low confidence: writes checkpoint but takes no rollback/confirm action
    expect(addJob).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('confirms T+30 with low confidence flag', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValue({
      score: 20,
      confidence: 0.1,
      missingSignals: [],
      reason: 'low confidence',
    });

    const execution = makeExecution({ deploymentStartedAt: T35_AGO, checkpoints: [] });
    mockLimit.mockResolvedValue([execution]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentStatusJob();

    expect(addJob).toHaveBeenCalledWith(
      'calibration',
      'execution.confirmed',
      expect.objectContaining({ confirmedWithLowConfidence: true })
    );
  });

  it('isolates errors per execution and continues processing others', async () => {
    // First execution throws during evaluateRisk, second succeeds
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk
      .mockImplementationOnce(() => {
        throw new Error('evaluation failed');
      })
      .mockReturnValue({ score: 20, confidence: 0.8, missingSignals: [], reason: 'ok' });

    const exec1 = makeExecution({ executionId: 'exec-1', deploymentStartedAt: T35_AGO });
    const exec2 = makeExecution({ executionId: 'exec-2', deploymentStartedAt: T35_AGO });
    mockLimit.mockResolvedValue([exec1, exec2]);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await processDeploymentStatusJob();
    consoleSpy.mockRestore();

    // Second execution should still be processed (confirm or rollback)
    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    expect(addJob).toHaveBeenCalledWith(
      'calibration',
      'execution.confirmed',
      expect.objectContaining({ executionId: 'exec-2' })
    );
  });
});
