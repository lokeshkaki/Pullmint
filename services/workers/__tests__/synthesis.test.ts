import type { Job } from 'bullmq';
import type { SynthesisJobData } from '../src/processors/synthesis';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {},
    llmCache: {},
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
  getGitHubInstallationClient: jest.fn().mockResolvedValue({
    rest: {
      checks: {
        listForRef: jest.fn().mockResolvedValue({
          data: { check_runs: [{ conclusion: 'success' }] },
        }),
      },
    },
  }),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((e: Error) => ({ message: e.message, context: {} })),
  retryWithBackoff: jest.fn((fn: () => unknown) => fn()),
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

jest.mock('../src/dedup', () => ({
  deduplicateFindings: jest.fn((findings: unknown[]) => findings),
}));

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'This PR has moderate architectural concerns.' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    },
  })),
}));

let mockDb: { select: jest.Mock; update: jest.Mock; insert: jest.Mock };

function buildMockDb() {
  mockDb = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ calibrationFactor: 1.0 }]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function makeSynthesisJob(
  childrenValues: Record<string, unknown>,
  overrides?: Partial<SynthesisJobData>
): Job<SynthesisJobData> {
  return {
    id: 'synth-job-1',
    name: 'synthesize',
    data: {
      executionId: 'exec-1',
      prEvent: {
        prNumber: 42,
        repoFullName: 'org/repo',
        headSha: 'abc123',
        baseSha: 'def456',
        author: 'alice',
        title: 'feat: test PR',
        orgId: 'org-1',
      },
      diffRef: 'diffs/exec-1.diff',
      agentTypes: ['architecture', 'security', 'performance', 'style'],
      cacheKey: 'test-cache-key',
      ...overrides,
    },
    getChildrenValues: jest.fn().mockResolvedValue(childrenValues),
  } as unknown as Job<SynthesisJobData>;
}

function makeAgentResult(agentType: string, overrides: Record<string, unknown> = {}) {
  return {
    agentType,
    findings: [
      {
        type: agentType === 'style' ? 'style' : agentType,
        severity: 'medium',
        title: `${agentType} finding`,
        description: `A ${agentType} issue`,
      },
    ],
    riskScore: 40,
    summary: `${agentType} summary`,
    model:
      agentType === 'performance' || agentType === 'style'
        ? 'claude-haiku-4-5-20251001'
        : 'claude-sonnet-4-6',
    tokens: 500,
    latencyMs: 3000,
    status: 'completed',
    ...overrides,
  };
}

describe('processSynthesisJob', () => {
  let processSynthesisJob: (job: Job<SynthesisJobData>) => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();

    jest.clearAllMocks();
    buildMockDb();
    (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);

    const mod = await import('../src/processors/synthesis');
    processSynthesisJob = mod.processSynthesisJob;
  });

  it('collects findings from all agents and forwards to github-integration', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
      'bull:agent:sec-1': makeAgentResult('security'),
      'bull:agent:perf-1': makeAgentResult('performance'),
      'bull:agent:style-1': makeAgentResult('style'),
    };

    const job = makeSynthesisJob(children);
    await processSynthesisJob(job);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    expect(addJob).toHaveBeenCalledWith(
      'github-integration',
      'analysis.complete',
      expect.objectContaining({
        executionId: 'exec-1',
        findingsCount: 4,
      })
    );
  });

  it('handles partial agent failure — 3 of 4 agents succeed', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture', { riskScore: 60 }),
      'bull:agent:sec-1': makeAgentResult('security', { riskScore: 40 }),
      'bull:agent:perf-1': makeAgentResult('performance', { status: 'failed', findings: [] }),
    };

    const job = makeSynthesisJob(children);
    await processSynthesisJob(job);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    expect(addJob).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('marks execution as failed when all agents fail', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture', { status: 'failed', findings: [] }),
      'bull:agent:sec-1': makeAgentResult('security', { status: 'failed', findings: [] }),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });
    await processSynthesisJob(job);

    const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
    expect(addJob).not.toHaveBeenCalled();

    const updateCalls = mockDb.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('skips LLM summary when there are no findings', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture', { findings: [], riskScore: 5 }),
      'bull:agent:sec-1': makeAgentResult('security', { findings: [], riskScore: 10 }),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });
    await processSynthesisJob(job);

    const Anthropic = jest.requireMock('@anthropic-ai/sdk').default;
    if (Anthropic.mock.results.length > 0) {
      const instance = Anthropic.mock.results[0]?.value;
      if (instance) {
        expect(instance.messages.create).not.toHaveBeenCalled();
      }
    }
  });

  it('calls deduplicateFindings on combined agent findings', async () => {
    const { deduplicateFindings } = jest.requireMock('../src/dedup') as {
      deduplicateFindings: jest.Mock;
    };

    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
      'bull:agent:sec-1': makeAgentResult('security'),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });
    await processSynthesisJob(job);

    expect(deduplicateFindings).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'architecture' }),
        expect.objectContaining({ type: 'security' }),
      ])
    );
  });

  it('computes weighted risk score with renormalization', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture', { riskScore: 80 }),
      'bull:agent:sec-1': makeAgentResult('security', { riskScore: 20 }),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });
    await processSynthesisJob(job);

    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };
    const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as { riskScore: number };

    expect(storedData.riskScore).toBe(50);
  });

  it('caches merged results for future cache hits', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture'],
      cacheKey: 'my-cache-key',
    });
    await processSynthesisJob(job);

    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('stores full results in MinIO', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
    };

    const job = makeSynthesisJob(children, { agentTypes: ['architecture'] });
    await processSynthesisJob(job);

    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };
    expect(putObject).toHaveBeenCalledWith(
      'test-value',
      expect.stringContaining('exec-1'),
      expect.any(String)
    );

    const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as {
      executionId: string;
      findings: unknown[];
      agentResults: Record<string, unknown>;
    };
    expect(storedData).toEqual(
      expect.objectContaining({
        executionId: 'exec-1',
        findings: expect.any(Array),
        agentResults: expect.any(Object),
      })
    );
  });

  it('records agent metadata including failed agents', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });
    await processSynthesisJob(job);

    const { putObject } = jest.requireMock('@pullmint/shared/storage') as { putObject: jest.Mock };
    const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as {
      agentResults: {
        security: { status: string };
        architecture: { status: string };
      };
    };

    expect(storedData.agentResults.security.status).toBe('failed');
    expect(storedData.agentResults.architecture.status).toBe('completed');
  });
});
