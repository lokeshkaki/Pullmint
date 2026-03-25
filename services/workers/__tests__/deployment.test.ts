import { processDeploymentJob } from '../src/processors/deployment';
import type { Job } from 'bullmq';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
    calibrations: {},
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    DEPLOYMENT: 'deployment',
    GITHUB_INTEGRATION: 'github-integration',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/risk-evaluator', () => ({
  evaluateRisk: jest.fn().mockReturnValue({
    score: 20,
    confidence: 0.8,
    missingSignals: [],
    reason: 'test',
  }),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((e: Error) => ({ message: e.message, context: {} })),
}));

jest.mock('@pullmint/shared/signal-weights', () => ({
  resolveSignalWeights: jest.fn().mockResolvedValue({
    'ci.result': 15,
    'ci.coverage': 10,
    'production.error_rate': 20,
    'production.latency': 10,
    time_of_day: 5,
    author_history: 10,
    simultaneous_deploy: 8,
    'deployment.status': 0,
  }),
}));

jest.mock('@pullmint/shared/execution-events', () => ({
  publishExecutionUpdate: jest.fn().mockResolvedValue(undefined),
  publishEvent: jest.fn().mockResolvedValue(undefined),
  closePublisher: jest.fn().mockResolvedValue(undefined),
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
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(makeWhereResult),
      }),
    }),
  };
}

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
  (
    jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
  ).getConfigOptional.mockImplementation((key: string) => {
    if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
    if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
    if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
    return undefined;
  });
  (
    jest.requireMock('@pullmint/shared/risk-evaluator') as { evaluateRisk: jest.Mock }
  ).evaluateRisk.mockReturnValue({
    score: 20,
    confidence: 0.8,
    missingSignals: [],
    reason: 'low risk',
  });
  // Mock globalThis.fetch for webhook calls
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: jest.fn().mockResolvedValue('') });
  (globalThis as Record<string, unknown>).fetch = mockFetch;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

function makeDeploymentJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'deployment_approved',
    data: {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 42,
      riskScore: 30,
      deploymentEnvironment: 'production',
      deploymentStrategy: 'eventbridge',
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'alice',
      title: 'feat: new feature',
      orgId: 'org-1',
      ...overrides,
    },
  } as unknown as Job;
}

describe('processDeploymentJob', () => {
  it('skips when deployment has already started (idempotency)', async () => {
    // deploymentStartedAt is already set
    mockLimit.mockResolvedValue([{ deploymentStartedAt: '2024-01-01T00:00:00.000Z' }]);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await processDeploymentJob(makeDeploymentJob());

    consoleSpy.mockRestore();
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).not.toHaveBeenCalled();
  });

  it('deploys successfully and publishes deployment.status event', async () => {
    // Idempotency check: no existing deployment
    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }]) // idempotency check
      .mockResolvedValueOnce([
        {
          // checkpoint2 execution fetch
          checkpoints: [],
          repoContext: null,
          signalsReceived: {},
        },
      ])
      .mockResolvedValueOnce([]); // calibration factor

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processDeploymentJob(makeDeploymentJob());

    expect(mockFetch).toHaveBeenCalledWith('https://deploy.example.com', expect.any(Object));
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'deployment.status',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it('blocks deployment when checkpoint2 risk score is too high', async () => {
    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };
    evaluateRisk.mockReturnValue({
      score: 75,
      confidence: 0.9,
      missingSignals: [],
      reason: 'high risk',
    });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processDeploymentJob(makeDeploymentJob());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(addJob).not.toHaveBeenCalled();
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ status: 'deployment-blocked' })
    );
  });

  it('handles missing webhook URL gracefully (no-url path)', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      return undefined; // No webhook URL
    });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processDeploymentJob(makeDeploymentJob());

    // No webhook configured, so deployment outcome is 'failed'
    expect(mockFetch).not.toHaveBeenCalled();
    // Should still publish deployment.status (with status=failed)
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'deployment.status',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it('writes failed status in finally block when an error is thrown', async () => {
    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockRejectedValueOnce(new Error('unexpected DB error')); // checkpoint2 throws

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processDeploymentJob(makeDeploymentJob())).rejects.toThrow('unexpected DB error');

    consoleSpy.mockRestore();
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('uses checkpoint wait/delay and calibration factor during successful deployment', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '1';
      if (key === 'DEPLOYMENT_DELAY_MS') return '1';
      return undefined;
    });

    const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
      evaluateRisk: jest.Mock;
    };

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([{ calibrationFactor: 1.25 }]);

    await processDeploymentJob(makeDeploymentJob({ riskScore: 15, checkpoint2Complete: true }));

    expect(evaluateRisk).toHaveBeenCalledWith(
      expect.objectContaining({ calibrationFactor: 1.25, llmBaseScore: 15 })
    );
    expect(mockFetch).toHaveBeenCalled();
  });

  describe('checkpoint2 delayed re-enqueue', () => {
    it('re-enqueues job with delay when checkpoint2Complete is not set', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
        if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
        if (key === 'CHECKPOINT_2_WAIT_MS') return '5000';
        return undefined;
      });

      mockLimit.mockResolvedValueOnce([{ deploymentStartedAt: null }]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

      await processDeploymentJob(makeDeploymentJob());

      expect(addJob).toHaveBeenCalledWith(
        'deployment',
        'deployment_approved',
        expect.objectContaining({ executionId: 'exec-1', checkpoint2Complete: true }),
        expect.objectContaining({ delay: 5000, jobId: 'exec-1-checkpoint2' })
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('runs checkpoint2 inline when checkpoint2Complete is true', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
        if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
        if (key === 'CHECKPOINT_2_WAIT_MS') return '5000';
        return undefined;
      });

      mockLimit
        .mockResolvedValueOnce([{ deploymentStartedAt: null }])
        .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
        .mockResolvedValueOnce([]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
        evaluateRisk: jest.Mock;
      };

      await processDeploymentJob(makeDeploymentJob({ checkpoint2Complete: true }));

      expect(
        addJob.mock.calls.some((call) => call[0] === 'deployment' && call[1] === 'deployment_approved')
      ).toBe(false);
      expect(evaluateRisk).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();
    });

    it('skips re-enqueue when CHECKPOINT_2_WAIT_MS is 0', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
        if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
        if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
        return undefined;
      });

      mockLimit
        .mockResolvedValueOnce([{ deploymentStartedAt: null }])
        .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
        .mockResolvedValueOnce([]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { evaluateRisk } = jest.requireMock('@pullmint/shared/risk-evaluator') as {
        evaluateRisk: jest.Mock;
      };

      await processDeploymentJob(makeDeploymentJob());

      expect(
        addJob.mock.calls.some((call) => call[0] === 'deployment' && call[1] === 'deployment_approved')
      ).toBe(false);
      expect(evaluateRisk).toHaveBeenCalled();
    });
  });

  it('retries webhook after a transient failure and then succeeds', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      if (key === 'DEPLOYMENT_WEBHOOK_RETRIES') return '1';
      return undefined;
    });

    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch
      .mockRejectedValueOnce(new Error('temporary network issue'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: jest.fn().mockResolvedValue('') });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    await processDeploymentJob(makeDeploymentJob());

    randomSpy.mockRestore();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns failed status with redacted webhook error body when response is non-OK', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      if (key === 'DEPLOYMENT_WEBHOOK_RETRIES') return '0';
      return undefined;
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('bearer super-secret-token'),
    });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentJob(makeDeploymentJob());

    const statusPayload = addJob.mock.calls[0]?.[2] as { message?: string };
    expect(statusPayload?.message).toContain('[REDACTED]');
  });

  it('triggers rollback when deployment webhook fails and rollback webhook is configured', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_ROLLBACK_WEBHOOK_URL') return 'https://rollback.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      if (key === 'DEPLOYMENT_WEBHOOK_RETRIES') return '0';
      return undefined;
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: jest.fn().mockResolvedValue('deploy failed'),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: jest.fn().mockResolvedValue('') });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentJob(makeDeploymentJob());

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://deploy.example.com', expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://rollback.example.com',
      expect.any(Object)
    );
    const statusPayload = addJob.mock.calls[0]?.[2] as { message?: string };
    expect(statusPayload?.message).toContain('Rollback triggered.');
  });

  it('records rollback failure when both deployment and rollback webhooks fail', async () => {
    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_ROLLBACK_WEBHOOK_URL') return 'https://rollback.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      if (key === 'DEPLOYMENT_WEBHOOK_RETRIES') return '0';
      return undefined;
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('primary failed'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('rollback failed'),
      });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentJob(makeDeploymentJob());

    const statusPayload = addJob.mock.calls[0]?.[2] as { message?: string };
    expect(statusPayload?.message).toContain('Rollback failed:');
  });

  it('fails deployment when fetch is unavailable in the runtime', async () => {
    delete (globalThis as Record<string, unknown>).fetch;

    (
      jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
    ).getConfigOptional.mockImplementation((key: string) => {
      if (key === 'DEPLOYMENT_WEBHOOK_URL') return 'https://deploy.example.com';
      if (key === 'DEPLOYMENT_WEBHOOK_SECRET') return 'secret-token';
      if (key === 'CHECKPOINT_2_WAIT_MS') return '0';
      if (key === 'DEPLOYMENT_WEBHOOK_RETRIES') return '0';
      return undefined;
    });

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockResolvedValueOnce([{ checkpoints: [], repoContext: null, signalsReceived: {} }])
      .mockResolvedValueOnce([]);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    await processDeploymentJob(makeDeploymentJob());

    const statusPayload = addJob.mock.calls[0]?.[2] as { message?: string };
    expect(statusPayload?.message).toContain('Fetch is not available in this runtime');
  });

  it('logs a critical error when finally status recovery write fails', async () => {
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    publishExecutionUpdate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('failed terminal status write'));

    mockLimit
      .mockResolvedValueOnce([{ deploymentStartedAt: null }])
      .mockRejectedValueOnce(new Error('checkpoint read exploded'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processDeploymentJob(makeDeploymentJob())).rejects.toThrow(
      'checkpoint read exploded'
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      'CRITICAL: Failed to write terminal status in finally block',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
