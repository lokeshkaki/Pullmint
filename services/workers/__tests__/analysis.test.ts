import type { Job } from 'bullmq';

// ---- Mocks ----
jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
    llmCache: {},
    llmRateLimits: {},
    calibrations: {},
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    ANALYSIS: 'analysis',
    AGENT: 'agent',
    SYNTHESIS: 'synthesis',
    GITHUB_INTEGRATION: 'github-integration',
  },
  getRedisConnection: jest.fn().mockReturnValue({}),
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn().mockReturnValue('test-value'),
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/storage', () => ({
  putObject: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

jest.mock('@pullmint/shared/utils', () => ({
  hashContent: jest.fn().mockReturnValue('mock-cache-key'),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((e: Error) => ({ message: e.message, context: {} })),
  retryWithBackoff: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('@pullmint/shared/execution-events', () => ({
  publishExecutionUpdate: jest.fn().mockResolvedValue(undefined),
  publishEvent: jest.fn().mockResolvedValue(undefined),
  closePublisher: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/checkpoint', () => ({
  buildAnalysisCheckpoint: jest.fn().mockResolvedValue({
    checkpoint1: {
      type: 'analysis',
      score: 30,
      confidence: 0.85,
      missingSignals: [],
      signals: [],
      decision: 'approved',
      reason: 'moderate risk',
      evaluatedAt: Date.now(),
    },
    calibrationFactor: 1.0,
  }),
}));

// Mock FlowProducer
const mockFlowAdd = jest.fn().mockResolvedValue({});
jest.mock('bullmq', () => ({
  ...jest.requireActual('bullmq'),
  FlowProducer: jest.fn().mockImplementation(() => ({
    add: mockFlowAdd,
  })),
}));

// ---- shared mock state ----
let mockDb: { select: jest.Mock; update: jest.Mock; insert: jest.Mock };
let mockLimit: jest.Mock;
let mockReturning: jest.Mock;

const mockOctokit = {
  rest: {
    pulls: { get: jest.fn() },
    checks: { listForRef: jest.fn() },
  },
};

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

  // Default: diff response with enough lines for full agent set
  const largeDiff = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join('\n');
  mockOctokit.rest.pulls.get.mockResolvedValue({ data: largeDiff });
  mockOctokit.rest.checks.listForRef.mockResolvedValue({
    data: { check_runs: [{ conclusion: 'success' }] },
  });
  (
    jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
  ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);
});

function makePRJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'pr.opened',
    data: {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 42,
      title: 'feat: add new feature',
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'alice',
      orgId: 'org-1',
      ...overrides,
    },
  } as unknown as Job;
}

describe('processAnalysisJob (dispatcher)', () => {
  // Use dynamic import so mocks are resolved
  let processAnalysisJob: (job: Job) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();

    // Re-apply mocks after resetModules
    buildMockDb();
    (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
    const largeDiff = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join('\n');
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: largeDiff });
    mockOctokit.rest.checks.listForRef.mockResolvedValue({
      data: { check_runs: [{ conclusion: 'success' }] },
    });
    (
      jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
    ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);

    const mod = await import('../src/processors/analysis');
    processAnalysisJob = mod.processAnalysisJob;
  });

  it('creates a BullMQ Flow with 4 agents on cache miss (large diff)', async () => {
    // Cache miss, within rate limit
    mockLimit.mockResolvedValueOnce([]); // cache miss
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK

    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };

    await processAnalysisJob(makePRJob());

    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith('exec-1', { status: 'analyzing' });

    // Should store diff in MinIO
    expect(putObject).toHaveBeenCalledWith(
      'test-value',
      expect.stringContaining('exec-1'),
      expect.any(String)
    );

    // Should create Flow with 4 children
    expect(mockFlowAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'synthesize',
        queueName: 'synthesis',
        children: expect.arrayContaining([
          expect.objectContaining({ name: 'architecture', queueName: 'agent' }),
          expect.objectContaining({ name: 'security', queueName: 'agent' }),
          expect.objectContaining({ name: 'performance', queueName: 'agent' }),
          expect.objectContaining({ name: 'style', queueName: 'agent' }),
        ]),
      })
    );
  });

  it('creates a Flow with only 2 agents for small diffs', async () => {
    // Small diff (< 200 lines)
    const smallDiff = '+line 1\n+line 2\n+line 3';
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: smallDiff });
    mockLimit.mockResolvedValueOnce([]); // cache miss
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK

    await processAnalysisJob(makePRJob());

    expect(mockFlowAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        children: expect.arrayContaining([
          expect.objectContaining({ name: 'architecture' }),
          expect.objectContaining({ name: 'security' }),
        ]),
      })
    );

    // Should NOT include performance or style
    const flowCall = mockFlowAdd.mock.calls[0][0] as {
      children: Array<{ name: string }>;
    };
    const childNames = flowCall.children.map((c) => c.name);
    expect(childNames).not.toContain('performance');
    expect(childNames).not.toContain('style');
  });

  it('uses cached result and skips Flow on cache hit', async () => {
    const cachedFindings = [
      { type: 'architecture', severity: 'medium', title: 'test', description: 'desc' },
    ];
    mockLimit.mockResolvedValueOnce([
      { cacheKey: 'mock-cache-key', findings: cachedFindings, riskScore: 25 },
    ]); // cache hit

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processAnalysisJob(makePRJob());

    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'completed',
        riskScore: 25,
      })
    );

    // Should NOT create Flow
    expect(mockFlowAdd).not.toHaveBeenCalled();

    // Should forward to github-integration
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({ executionId: 'exec-1', riskScore: 25 })
    );
  });

  it('uses placeholder result when rate limit is exceeded', async () => {
    mockLimit.mockResolvedValueOnce([]); // cache miss
    mockReturning.mockResolvedValueOnce([{ counter: 99 }]); // rate limit exceeded

    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processAnalysisJob(makePRJob());

    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'completed',
        riskScore: 50,
      })
    );

    consoleSpy.mockRestore();

    // Should NOT create Flow
    expect(mockFlowAdd).not.toHaveBeenCalled();

    // Should forward placeholder to github-integration
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({ riskScore: 50, findingsCount: 0 })
    );
  });

  it('passes diffRef and agentTypes in Flow data', async () => {
    mockLimit.mockResolvedValueOnce([]); // cache miss
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK

    await processAnalysisJob(makePRJob());

    const flowCall = mockFlowAdd.mock.calls[0][0] as {
      data: {
        executionId: string;
        agentTypes: string[];
        cacheKey: string;
        diffRef: string;
      };
      children: Array<{
        data: {
          agentType: string;
          diffRef: string;
          executionId: string;
        };
        opts: { failParentOnFailure: false };
      }>;
    };

    // Parent (synthesizer) should have agentTypes and cacheKey
    expect(flowCall.data).toEqual(
      expect.objectContaining({
        executionId: 'exec-1',
        agentTypes: expect.arrayContaining(['architecture', 'security']),
        cacheKey: 'mock-cache-key',
        diffRef: expect.stringContaining('exec-1'),
      })
    );

    // Each child should have agentType and diffRef
    for (const child of flowCall.children) {
      expect(child.data).toEqual(
        expect.objectContaining({
          agentType: expect.any(String),
          diffRef: expect.stringContaining('exec-1'),
          executionId: 'exec-1',
        })
      );
      expect(child.opts).toEqual({ failParentOnFailure: false });
    }
  });

  it('marks execution as failed on error', async () => {
    (
      jest.requireMock('@pullmint/shared/error-handling') as { retryWithBackoff: jest.Mock }
    ).retryWithBackoff.mockRejectedValueOnce(new Error('GitHub API error'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processAnalysisJob(makePRJob())).rejects.toThrow('GitHub API error');

    consoleSpy.mockRestore();
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ status: 'failed' })
    );
  });
});
