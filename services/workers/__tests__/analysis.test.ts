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
    repos: { getContent: jest.fn() },
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
  let fetchRepoConfig: typeof import('../src/processors/analysis').fetchRepoConfig;

  beforeEach(async () => {
    jest.resetModules();

    // Re-apply mocks after resetModules
    buildMockDb();
    (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
    const largeDiff = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join('\n');
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: largeDiff });
    mockOctokit.rest.repos.getContent.mockRejectedValue({ status: 404 });
    mockOctokit.rest.checks.listForRef.mockResolvedValue({
      data: { check_runs: [{ conclusion: 'success' }] },
    });
    (
      jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
    ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);

    const mod = await import('../src/processors/analysis');
    processAnalysisJob = mod.processAnalysisJob;
    fetchRepoConfig = mod.fetchRepoConfig;
  });

  it('parses a valid .pullmint.yml config file', async () => {
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(
          ['severity_threshold: medium', 'ignore_paths:', '  - generated/**'].join('\n')
        ).toString('base64'),
      },
    });

    const result = await fetchRepoConfig(mockOctokit as never, 'org', 'repo', 'abc123');

    expect(result).toEqual(
      expect.objectContaining({
        severity_threshold: 'medium',
        ignore_paths: ['generated/**'],
      })
    );
  });

  it('returns defaults when YAML is invalid', async () => {
    const logWarning = jest.fn();
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from('severity_threshold: [').toString('base64'),
      },
    });

    const result = await fetchRepoConfig(mockOctokit as never, 'org', 'repo', 'abc123', logWarning);

    expect(result).toEqual({
      severity_threshold: 'low',
      ignore_paths: [],
      agents: {
        architecture: true,
        security: true,
        performance: true,
        style: true,
      },
    });
    expect(logWarning).toHaveBeenCalled();
  });

  it('returns defaults when .pullmint.yml is missing', async () => {
    mockOctokit.rest.repos.getContent.mockRejectedValueOnce({ status: 404 });

    const result = await fetchRepoConfig(mockOctokit as never, 'org', 'repo', 'abc123');

    expect(result).toEqual({
      severity_threshold: 'low',
      ignore_paths: [],
      agents: {
        architecture: true,
        security: true,
        performance: true,
        style: true,
      },
    });
  });

  it('returns defaults when config fetch fails with a server error', async () => {
    const logWarning = jest.fn();
    mockOctokit.rest.repos.getContent.mockRejectedValueOnce({ status: 500, message: 'boom' });

    const result = await fetchRepoConfig(mockOctokit as never, 'org', 'repo', 'abc123', logWarning);

    expect(result).toEqual({
      severity_threshold: 'low',
      ignore_paths: [],
      agents: {
        architecture: true,
        security: true,
        performance: true,
        style: true,
      },
    });
    expect(logWarning).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Failed to load .pullmint.yml')
    );
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

  it('disables configured agents from .pullmint.yml', async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]);
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(['agents:', '  performance: false'].join('\n')).toString('base64'),
      },
    });

    await processAnalysisJob(makePRJob());

    const flowCall = mockFlowAdd.mock.calls[0][0] as {
      children: Array<{ name: string; data: { userIgnorePaths?: string[] } }>;
    };
    const childNames = flowCall.children.map((child) => child.name);

    expect(childNames).toEqual(['architecture', 'security', 'style']);
  });

  it('keeps security enabled when all agents are disabled', async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]);
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(
          ['agents:', '  architecture: false', '  security: false', '  performance: false', '  style: false'].join('\n')
        ).toString('base64'),
      },
    });

    await processAnalysisJob(makePRJob());

    const flowCall = mockFlowAdd.mock.calls[0][0] as {
      children: Array<{ name: string }>;
      data: { agentTypes: string[] };
    };

    expect(flowCall.children.map((child) => child.name)).toEqual(['security']);
    expect(flowCall.data.agentTypes).toEqual(['security']);
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
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(
          ['ignore_paths:', '  - generated/**', '  - vendor/**'].join('\n')
        ).toString('base64'),
      },
    });

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
          userIgnorePaths?: string[];
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
          userIgnorePaths: ['generated/**', 'vendor/**'],
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
