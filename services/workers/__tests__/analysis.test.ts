import { processAnalysisJob } from '../src/processors/analysis';
import type { Job } from 'bullmq';

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
    GITHUB_INTEGRATION: 'github-integration',
  },
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

jest.mock('@pullmint/shared/risk-evaluator', () => ({
  evaluateRisk: jest.fn().mockReturnValue({
    score: 30,
    confidence: 0.85,
    missingSignals: [],
    reason: 'moderate risk',
  }),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((e: Error) => ({ message: e.message, context: {} })),
  retryWithBackoff: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"findings":[],"riskScore":25,"summary":"No issues"}' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  })),
}));

// ---- shared mock state ----
let mockDb: { select: jest.Mock; update: jest.Mock; insert: jest.Mock };
let mockLimit: jest.Mock;
let mockReturning: jest.Mock;

const mockOctokit = {
  rest: {
    pulls: {
      get: jest.fn(),
    },
    checks: {
      listForRef: jest.fn(),
    },
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

  // Set up octokit mock
  mockOctokit.rest.pulls.get.mockResolvedValue({
    data: '+++ b/src/index.ts\n@@ -1 +1 @@\n+const x = 1;\n--- a/src/index.ts\n+const y = 2;',
  });
  mockOctokit.rest.checks.listForRef.mockResolvedValue({
    data: { check_runs: [{ conclusion: 'success' }] },
  });
  (
    jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
  ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);

  (
    jest.requireMock('@pullmint/shared/config') as {
      getConfig: jest.Mock;
      getConfigOptional: jest.Mock;
    }
  ).getConfig.mockReturnValue('test-value');
  (
    jest.requireMock('@pullmint/shared/config') as {
      getConfig: jest.Mock;
      getConfigOptional: jest.Mock;
    }
  ).getConfigOptional.mockReturnValue(undefined);
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

describe('processAnalysisJob', () => {
  it('uses cached result when cache hit exists', async () => {
    const cachedFindings = [
      { type: 'test', severity: 'low', title: 'test', description: 'desc', suggestion: 'fix' },
    ];
    // Cache hit: first limit call returns cached row
    mockLimit
      .mockResolvedValueOnce([
        { cacheKey: 'mock-cache-key', findings: cachedFindings, riskScore: 25 },
      ]) // cache hit
      .mockResolvedValueOnce([{ calibrationFactor: 1.0 }]); // calibration

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

    await processAnalysisJob(makePRJob());

    // Should NOT call LLM
    const anthropicMock = jest.requireMock('@anthropic-ai/sdk') as { default: jest.Mock };
    const instance = anthropicMock.default.mock.results[0]?.value as
      | { messages: { create: jest.Mock } }
      | undefined;
    if (instance) {
      expect(instance.messages.create).not.toHaveBeenCalled();
    }

    // Should publish analysis.complete
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({ executionId: 'exec-1', riskScore: 25 })
    );
  });

  it('calls LLM and publishes result on cache miss', async () => {
    // Cache miss, within rate limit
    mockLimit
      .mockResolvedValueOnce([]) // cache miss
      .mockResolvedValueOnce([{ calibrationFactor: 1.0 }]); // calibration factor
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit counter

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };

    await processAnalysisJob(makePRJob());

    expect(putObject).toHaveBeenCalled();
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it('uses placeholder result when LLM rate limit is exceeded', async () => {
    mockLimit
      .mockResolvedValueOnce([]) // cache miss
      .mockResolvedValueOnce([{ calibrationFactor: 1.0 }]); // calibration
    // Rate limit counter exceeds hourlyLimit (default 10)
    mockReturning.mockResolvedValueOnce([{ counter: 99 }]); // rate limit exceeded

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await processAnalysisJob(makePRJob());

    consoleSpy.mockRestore();
    // Should still publish with placeholder riskScore=50
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({ riskScore: 50 })
    );
  });

  it('updates execution status to failed and rethrows on error', async () => {
    // Make the PR fetch fail
    (
      jest.requireMock('@pullmint/shared/error-handling') as { retryWithBackoff: jest.Mock }
    ).retryWithBackoff.mockRejectedValueOnce(new Error('GitHub API error'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processAnalysisJob(makePRJob())).rejects.toThrow('GitHub API error');

    consoleSpy.mockRestore();
    // Should update status to failed
    const updateCalls = mockDb.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('stores analysis result in S3 and caches it in DB', async () => {
    mockLimit
      .mockResolvedValueOnce([]) // cache miss
      .mockResolvedValueOnce([{ calibrationFactor: 1.0 }]);
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]);

    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };

    await processAnalysisJob(makePRJob());

    expect(putObject).toHaveBeenCalledWith(
      'test-value', // analysisBucket from getConfig
      expect.stringContaining('exec-1'),
      expect.any(String)
    );
    // Should also insert into cache
    expect(mockDb.insert).toHaveBeenCalled();
  });
});
