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
  getObject: jest.fn().mockResolvedValue(null),
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

jest.mock('@pullmint/shared/cost-tracker', () => ({
  checkBudget: jest.fn().mockResolvedValue({
    allowed: true,
    usedUsd: 0,
    budgetUsd: 0,
    remainingUsd: 0,
  }),
  recordTokenUsage: jest.fn().mockResolvedValue(undefined),
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

  const orderBy = jest.fn().mockReturnValue({ limit: mockLimit });
  const whereResult = {
    limit: mockLimit,
    orderBy,
  };

  const makeWhereResult = () =>
    Object.assign(Promise.resolve(undefined) as Promise<unknown>, {
      returning: mockReturning,
      limit: mockLimit,
    });

  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(whereResult),
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

function makePRJob(overrides: Record<string, unknown> = {}, name = 'pr.opened'): Job {
  return {
    name,
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
      custom_agents: [],
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
      custom_agents: [],
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
      custom_agents: [],
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

  it('adds custom agent children and passes custom weights to synthesizer', async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]);
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(
          [
            'custom_agents:',
            '  - name: accessibility',
            '    type: accessibility',
            '    prompt: "You are an accessibility expert. Analyze WCAG issues in changed UI code and provide actionable fixes for keyboard, ARIA, and labels."',
            '    model: claude-haiku-4-5-20251001',
            '    include_paths:',
            '      - src/components/**',
            '    exclude_paths:',
            '      - "**/*.test.*"',
            '    max_diff_chars: 50000',
            '    weight: 0.15',
            '    severity_filter: medium',
          ].join('\n')
        ).toString('base64'),
      },
    });

    await processAnalysisJob(makePRJob());

    const flowCall = mockFlowAdd.mock.calls[0][0] as {
      data: {
        agentTypes: string[];
        customAgentWeights: Record<string, number>;
      };
      children: Array<{
        name: string;
        data: {
          agentType: string;
          customAgentConfig?: {
            prompt: string;
            model?: string;
            includePaths?: string[];
            excludePaths?: string[];
            maxDiffChars: number;
            severityFilter?: string;
          };
        };
      }>;
    };

    expect(flowCall.data.agentTypes).toContain('accessibility');
    expect(flowCall.data.customAgentWeights).toEqual({ accessibility: 0.15 });

    const customChild = flowCall.children.find((child) => child.name === 'accessibility');
    expect(customChild).toBeDefined();
    expect(customChild?.data.agentType).toBe('accessibility');
    expect(customChild?.data.customAgentConfig).toEqual(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        includePaths: ['src/components/**'],
        excludePaths: ['**/*.test.*'],
        maxDiffChars: 50000,
        severityFilter: 'medium',
      })
    );
  });

  it('keeps security enabled when all agents are disabled', async () => {
    mockLimit.mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ counter: 1 }]);
    mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        content: Buffer.from(
          [
            'agents:',
            '  architecture: false',
            '  security: false',
            '  performance: false',
            '  style: false',
          ].join('\n')
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

  describe('incremental analysis on synchronize', () => {
    it('reuses prior results when delta is small', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK
      mockLimit.mockResolvedValueOnce([]); // no in-progress execution
      mockLimit.mockResolvedValueOnce([
        { executionId: 'prev-exec', s3Key: 'executions/prev-exec/analysis.json' },
      ]); // prior completed execution

      const priorDiff = [
        'diff --git a/src/main.ts b/src/main.ts',
        '--- a/src/main.ts',
        '+++ b/src/main.ts',
        '@@ -1 +1 @@',
        '-old-main',
        '+new-main',
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -1 +1 @@',
        '-old-service',
        '+new-service',
        'diff --git a/docs/notes.md b/docs/notes.md',
        '--- a/docs/notes.md',
        '+++ b/docs/notes.md',
        '@@ -1 +1 @@',
        '-old-docs',
        '+docs-v1',
      ].join('\n');

      const newDiff = [
        'diff --git a/src/main.ts b/src/main.ts',
        '--- a/src/main.ts',
        '+++ b/src/main.ts',
        '@@ -1 +1 @@',
        '-old-main',
        '+new-main',
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -1 +1 @@',
        '-old-service',
        '+new-service',
        'diff --git a/docs/notes.md b/docs/notes.md',
        '--- a/docs/notes.md',
        '+++ b/docs/notes.md',
        '@@ -1 +1 @@',
        '-old-docs',
        '+docs-v2',
      ];

      while (newDiff.length < 250) {
        newDiff.push(`+padding ${newDiff.length}`);
      }

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: newDiff.join('\n') });

      const priorFindings = [
        {
          type: 'architecture',
          severity: 'medium',
          title: 'Architecture finding',
          description: 'arch detail',
        },
        {
          type: 'security',
          severity: 'low',
          title: 'Security finding',
          description: 'sec detail',
        },
        {
          type: 'performance',
          severity: 'low',
          title: 'Performance finding',
          description: 'perf detail',
        },
        {
          type: 'style',
          severity: 'info',
          title: 'Style finding',
          description: 'style detail',
        },
      ];

      const priorResultPayload = {
        findings: priorFindings,
        agentResults: {
          architecture: {
            riskScore: 70,
            model: 'm1',
            tokens: 10,
            latencyMs: 20,
            status: 'completed',
          },
          security: { riskScore: 40, model: 'm2', tokens: 11, latencyMs: 21, status: 'completed' },
          performance: {
            riskScore: 30,
            model: 'm3',
            tokens: 12,
            latencyMs: 22,
            status: 'completed',
          },
          style: { riskScore: 20, model: 'm4', tokens: 13, latencyMs: 23, status: 'completed' },
        },
      };

      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockImplementation((_bucket: string, key: string) => {
        if (key === 'executions/prev-exec/analysis.json') {
          return JSON.stringify(priorResultPayload);
        }
        if (key === 'diffs/prev-exec.diff') {
          return priorDiff;
        }
        return null;
      });

      await processAnalysisJob(makePRJob({}, 'pr.synchronize'));

      const flowCall = mockFlowAdd.mock.calls[0][0] as {
        children: Array<{ name: string }>;
        data: {
          agentTypes: string[];
          priorAgentResults?: Record<string, unknown>;
          rerunAgentTypes?: string[];
        };
      };

      expect(flowCall.children.map((child) => child.name)).toEqual([
        'architecture',
        'security',
        'style',
      ]);
      expect(flowCall.data.agentTypes).toEqual([
        'architecture',
        'security',
        'style',
        'performance',
      ]);
      expect(flowCall.data.priorAgentResults).toEqual(
        expect.objectContaining({ performance: expect.any(Object) })
      );
      expect(flowCall.data.rerunAgentTypes).toEqual(['architecture', 'security', 'style']);

      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };
      expect(publishExecutionUpdate).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({
          metadata: expect.objectContaining({ incremental: true }),
        })
      );
    });

    it('falls back to full analysis when no prior execution exists', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK
      mockLimit.mockResolvedValueOnce([]); // no in-progress execution
      mockLimit.mockResolvedValueOnce([]); // no completed prior execution

      await processAnalysisJob(makePRJob({}, 'pr.synchronize'));

      const flowCall = mockFlowAdd.mock.calls[0][0] as { children: Array<{ name: string }> };
      expect(flowCall.children.map((child) => child.name)).toEqual([
        'architecture',
        'security',
        'performance',
        'style',
      ]);
    });

    it('falls back to full analysis when delta exceeds threshold', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK
      mockLimit.mockResolvedValueOnce([]); // no in-progress execution
      mockLimit.mockResolvedValueOnce([
        { executionId: 'prev-exec', s3Key: 'executions/prev-exec/analysis.json' },
      ]);

      const priorDiff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');

      const newDiff = [
        'diff --git a/src/c.ts b/src/c.ts',
        '--- a/src/c.ts',
        '+++ b/src/c.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/src/d.ts b/src/d.ts',
        '--- a/src/d.ts',
        '+++ b/src/d.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ];
      while (newDiff.length < 250) {
        newDiff.push(`+padding ${newDiff.length}`);
      }
      mockOctokit.rest.pulls.get.mockResolvedValue({ data: newDiff.join('\n') });

      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockImplementation((_bucket: string, key: string) => {
        if (key === 'executions/prev-exec/analysis.json') {
          return JSON.stringify({ findings: [], agentResults: {} });
        }
        if (key === 'diffs/prev-exec.diff') {
          return priorDiff;
        }
        return null;
      });

      await processAnalysisJob(makePRJob({}, 'pr.synchronize'));

      const flowCall = mockFlowAdd.mock.calls[0][0] as {
        children: Array<{ name: string }>;
        data: { priorAgentResults?: Record<string, unknown> };
      };
      expect(flowCall.children.map((child) => child.name)).toEqual([
        'architecture',
        'security',
        'performance',
        'style',
      ]);
      expect(flowCall.data.priorAgentResults).toBeUndefined();
    });

    it('falls back to full analysis when prior execution is in-progress', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK
      mockLimit.mockResolvedValueOnce([{ executionId: 'other-exec' }]); // in progress

      await processAnalysisJob(makePRJob({}, 'pr.synchronize'));

      const flowCall = mockFlowAdd.mock.calls[0][0] as { children: Array<{ name: string }> };
      expect(flowCall.children.map((child) => child.name)).toEqual([
        'architecture',
        'security',
        'performance',
        'style',
      ]);
    });

    it('falls back to full analysis on pr.opened events', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK

      await processAnalysisJob(makePRJob({}, 'pr.opened'));

      const flowCall = mockFlowAdd.mock.calls[0][0] as {
        data: { priorAgentResults?: Record<string, unknown>; rerunAgentTypes?: string[] };
      };
      expect(flowCall.data.priorAgentResults).toBeUndefined();
      expect(flowCall.data.rerunAgentTypes).toBeUndefined();
    });

    it('falls back gracefully on MinIO fetch error', async () => {
      mockLimit.mockResolvedValueOnce([]); // cache miss
      mockReturning.mockResolvedValueOnce([{ counter: 1 }]); // rate limit OK
      mockLimit.mockResolvedValueOnce([]); // no in-progress execution
      mockLimit.mockResolvedValueOnce([
        { executionId: 'prev-exec', s3Key: 'executions/prev-exec/analysis.json' },
      ]);

      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockRejectedValue(new Error('minio failure'));

      await expect(processAnalysisJob(makePRJob({}, 'pr.synchronize'))).resolves.toBeUndefined();

      const flowCall = mockFlowAdd.mock.calls[0][0] as { children: Array<{ name: string }> };
      expect(flowCall.children.map((child) => child.name)).toEqual([
        'architecture',
        'security',
        'performance',
        'style',
      ]);
    });
  });
});
