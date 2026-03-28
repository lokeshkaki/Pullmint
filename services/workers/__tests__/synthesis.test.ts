import type { Job } from 'bullmq';
import type { SynthesisJobData } from '../src/processors/synthesis';
import type { AgentResult } from '../src/processors/agent';

let mockChat: jest.Mock;

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

jest.mock('@pullmint/shared/execution-events', () => ({
  publishExecutionUpdate: jest.fn().mockResolvedValue(undefined),
  publishEvent: jest.fn().mockResolvedValue(undefined),
  closePublisher: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pullmint/shared/cost-tracker', () => ({
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

jest.mock('@pullmint/shared/dedup', () => ({
  deduplicateFindings: jest.fn((findings: unknown[]) => findings),
}));

jest.mock('../src/finding-fingerprint', () => ({
  fingerprintFindings: jest.fn((findings: unknown[]) => findings),
}));

jest.mock('../src/finding-lifecycle', () => ({
  analyzeFindingLifecycle: jest.fn(() => ({
    findings: [],
    resolved: [],
    stats: { new: 0, persisted: 0, resolved: 0 },
  })),
}));

jest.mock('@pullmint/shared/llm', () => ({
  createLLMProvider: jest.fn(() => ({
    chat: jest.fn((...args: unknown[]) => mockChat(...args)),
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

function makeAgentResult(
  agentType: 'architecture' | 'security' | 'performance' | 'style',
  overrides: Partial<AgentResult> = {}
): AgentResult {
  return {
    agentType,
    findings: [
      {
        type: agentType,
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
    mockChat = jest.fn().mockResolvedValue({
      text: 'Synthesized summary of findings.',
      inputTokens: 50,
      outputTokens: 30,
    });
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
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(addJob).toHaveBeenCalled();
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ status: 'completed' })
    );
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
    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    expect(addJob).not.toHaveBeenCalled();
    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({ status: 'failed' })
    );
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

    expect(mockChat).not.toHaveBeenCalled();
  });

  it('records token usage for synthesis summary calls', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
      'bull:agent:sec-1': makeAgentResult('security'),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['architecture', 'security'],
    });

    await processSynthesisJob(job);

    const { recordTokenUsage } = jest.requireMock('@pullmint/shared/cost-tracker') as {
      recordTokenUsage: jest.Mock;
    };

    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        agentType: 'synthesis',
      })
    );
  });

  it('calls deduplicateFindings on combined agent findings', async () => {
    const { deduplicateFindings } = jest.requireMock('@pullmint/shared/dedup') as {
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

  it('includes lifecycle stats in the github-integration job', async () => {
    const { analyzeFindingLifecycle } = await import('../src/finding-lifecycle');
    (analyzeFindingLifecycle as jest.Mock).mockReturnValueOnce({
      findings: [
        {
          type: 'security',
          severity: 'high',
          title: 'Issue',
          description: 'Desc',
          lifecycle: 'new',
          fingerprint: 'abc123abc123abcd',
        },
      ],
      resolved: [],
      stats: { new: 1, persisted: 0, resolved: 0 },
    });

    mockDb.select.mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValueOnce([{ s3Key: undefined, findings: [] }]),
        }),
      }),
    });

    const children = {
      'bull:agent:sec-1': makeAgentResult('security'),
    };

    const job = makeSynthesisJob(children, {
      agentTypes: ['security'],
      priorExecutionId: 'exec-prior',
    });

    await processSynthesisJob(job);

    const { addJob } = await import('@pullmint/shared/queue');
    const call = (addJob as jest.Mock).mock.calls.find(
      ([queue]: [string]) => queue === 'github-integration'
    );

    expect(call).toBeDefined();
    const jobData = call?.[2] as Record<string, unknown>;
    const meta = jobData.metadata as Record<string, unknown>;
    expect(meta.lifecycle).toEqual({ new: 1, persisted: 0, resolved: 0 });
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

  it('rethrows synthesis errors even when failed status update also errors', async () => {
    const children = {
      'bull:agent:arch-1': makeAgentResult('architecture'),
    };

    const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
      publishExecutionUpdate: jest.Mock;
    };
    publishExecutionUpdate.mockRejectedValueOnce(new Error('status update failed'));

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const job = makeSynthesisJob(children, {
      prEvent: {
        prNumber: 42,
        repoFullName: 'invalid-repo-name',
        headSha: 'abc123',
        baseSha: 'def456',
        author: 'alice',
        title: 'feat: test PR',
        orgId: 'org-1',
      },
      agentTypes: ['architecture'],
    });

    await expect(processSynthesisJob(job)).rejects.toThrow('Invalid repoFullName format');

    expect(publishExecutionUpdate).toHaveBeenCalledWith(
      'exec-1',
      expect.objectContaining({
        status: 'failed',
      })
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to update execution status:',
      expect.objectContaining({ executionId: 'exec-1' })
    );

    consoleErrorSpy.mockRestore();
  });

  describe('incremental result merging', () => {
    it('merges prior results with new agent results', async () => {
      const children = {
        'bull:agent:arch-1': makeAgentResult('architecture'),
        'bull:agent:sec-1': makeAgentResult('security'),
      };

      const priorAgentResults = {
        performance: makeAgentResult('performance'),
        style: makeAgentResult('style'),
      };

      const job = makeSynthesisJob(children, {
        priorAgentResults,
        rerunAgentTypes: ['architecture', 'security'],
      });

      await processSynthesisJob(job);

      const { putObject } = jest.requireMock('@pullmint/shared/storage') as {
        putObject: jest.Mock;
      };
      const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as {
        findings: unknown[];
        agentResults: Record<string, unknown>;
      };

      expect(storedData.findings).toHaveLength(4);
      expect(Object.keys(storedData.agentResults).sort()).toEqual([
        'architecture',
        'performance',
        'security',
        'style',
      ]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      expect(addJob).toHaveBeenCalledWith(
        'github-integration',
        'analysis.complete',
        expect.objectContaining({
          metadata: expect.objectContaining({
            incremental: true,
            rerunAgents: ['architecture', 'security'],
          }),
        })
      );
    });

    it('new results override prior results for the same agent type', async () => {
      const priorAgentResults = {
        architecture: makeAgentResult('architecture', {
          riskScore: 5,
          findings: [
            {
              type: 'architecture',
              severity: 'low',
              title: 'Old architecture finding',
              description: 'old description',
            },
          ],
        }),
      };

      const children = {
        'bull:agent:arch-1': makeAgentResult('architecture', {
          riskScore: 90,
          findings: [
            {
              type: 'architecture',
              severity: 'high',
              title: 'New architecture finding',
              description: 'new description',
            },
          ],
        }),
      };

      const job = makeSynthesisJob(children, {
        agentTypes: ['architecture'],
        priorAgentResults,
        rerunAgentTypes: ['architecture'],
      });

      await processSynthesisJob(job);

      const { putObject } = jest.requireMock('@pullmint/shared/storage') as {
        putObject: jest.Mock;
      };
      const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as {
        riskScore: number;
      };

      expect(storedData.riskScore).toBe(90);
    });

    it('works normally without priorAgentResults', async () => {
      const children = {
        'bull:agent:perf-1': makeAgentResult('performance'),
      };

      const job = makeSynthesisJob(children, {
        agentTypes: ['performance'],
      });
      await processSynthesisJob(job);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      expect(addJob).toHaveBeenCalledWith(
        'github-integration',
        'analysis.complete',
        expect.objectContaining({
          executionId: 'exec-1',
          findingsCount: 1,
        })
      );
    });
  });

  describe('custom agent weight renormalization', () => {
    it('includes custom agent in weighted risk score', async () => {
      const children = {
        'bull:agent:arch-1': makeAgentResult('architecture', { riskScore: 80 }),
        'bull:agent:sec-1': makeAgentResult('security', { riskScore: 80 }),
        'bull:agent:acc-1': {
          agentType: 'accessibility',
          findings: [],
          riskScore: 0,
          summary: '',
          model: 'claude-haiku-4-5-20251001',
          tokens: 50,
          latencyMs: 200,
          status: 'completed' as const,
        },
      };

      const job = makeSynthesisJob(children, {
        agentTypes: ['architecture', 'security', 'accessibility'],
        customAgentWeights: { accessibility: 0.1 },
      });
      await processSynthesisJob(job);

      const { putObject } = jest.requireMock('@pullmint/shared/storage') as {
        putObject: jest.Mock;
      };
      const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as { riskScore: number };

      // architecture=0.35, security=0.35, accessibility=0.10 → total=0.80
      // normalized: arch=0.4375, sec=0.4375, acc=0.125
      // score: 80*0.4375 + 80*0.4375 + 0*0.125 = 70
      expect(storedData.riskScore).toBe(70);
    });

    it('handles custom agent failure gracefully via renormalization', async () => {
      const children = {
        'bull:agent:arch-1': makeAgentResult('architecture', { riskScore: 60 }),
        'bull:agent:acc-1': {
          agentType: 'accessibility',
          findings: [],
          riskScore: 0,
          summary: '',
          model: 'claude-haiku-4-5-20251001',
          tokens: 0,
          latencyMs: 0,
          status: 'failed' as const,
        },
      };

      const job = makeSynthesisJob(children, {
        agentTypes: ['architecture', 'accessibility'],
        customAgentWeights: { accessibility: 0.1 },
      });
      await processSynthesisJob(job);

      const { putObject } = jest.requireMock('@pullmint/shared/storage') as {
        putObject: jest.Mock;
      };
      const storedData = JSON.parse(putObject.mock.calls[0][2] as string) as { riskScore: number };

      // Only architecture completed → normalized weight = 1.0 → score = 60
      expect(storedData.riskScore).toBe(60);
    });
  });
});
