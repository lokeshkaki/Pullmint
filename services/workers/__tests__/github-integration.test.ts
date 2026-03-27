import {
  buildReviewPayload,
  buildCommentBody,
  getRiskEmoji,
  processGitHubIntegrationJob,
} from '../src/processors/github-integration';
import { parseDiff } from '../src/diff-filter';
import type { Job } from 'bullmq';

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
    GITHUB_INTEGRATION: 'github-integration',
    NOTIFICATION: 'notification',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn().mockReturnValue('test-value'),
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/storage', () => ({
  getObject: jest.fn().mockResolvedValue(null),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
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

jest.mock('@pullmint/shared/schemas', () => {
  const z = jest.requireActual<typeof import('zod')>('zod');
  return {
    FindingSchema: z.object({
      type: z.string(),
      severity: z.string(),
      title: z.string(),
      description: z.string(),
      suggestion: z.string().optional(),
    }),
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
    ValidatedCheckpointRecord: undefined,
  };
});

// ---- shared DB mock state ----
let mockDb: { select: jest.Mock; update: jest.Mock };
let mockLimit: jest.Mock;
let mockReturning: jest.Mock;

const mockOctokit = {
  rest: {
    issues: {
      createComment: jest.fn(),
      addLabels: jest.fn(),
    },
    pulls: {
      createReview: jest.fn(),
    },
    repos: {
      getCombinedStatusForRef: jest.fn(),
      createDeployment: jest.fn(),
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
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildMockDb();
  (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(mockDb);
  (
    jest.requireMock('@pullmint/shared/github-app') as { getGitHubInstallationClient: jest.Mock }
  ).getGitHubInstallationClient.mockResolvedValue(mockOctokit);

  // Default config
  (
    jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
  ).getConfigOptional.mockImplementation((key: string) => {
    if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
    if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
    if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
    if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
    return undefined;
  });

  mockOctokit.rest.issues.createComment.mockResolvedValue({});
  mockOctokit.rest.issues.addLabels.mockResolvedValue({});
  mockOctokit.rest.pulls.createReview.mockResolvedValue({});
  mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
    data: { state: 'success', statuses: [] },
  });
  mockOctokit.rest.repos.createDeployment.mockResolvedValue({});
  mockOctokit.rest.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
});

function makeAnalysisCompleteJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'analysis.complete',
    data: {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 42,
      riskScore: 30,
      findings: [],
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'alice',
      title: 'feat: test',
      orgId: 'org-1',
      deploymentStrategy: 'eventbridge',
      deploymentEnvironment: 'production',
      ...overrides,
    },
  } as unknown as Job;
}

function makeDeploymentStatusJob(status: string, overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'deployment.status',
    data: {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 42,
      deploymentStatus: status,
      deploymentEnvironment: 'production',
      deploymentStrategy: 'eventbridge',
      message: status === 'deployed' ? 'Deployed successfully' : 'Deployment failed',
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'alice',
      title: 'feat: test',
      orgId: 'org-1',
      ...overrides,
    },
  } as unknown as Job;
}

function makeBudgetExceededJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'budget.exceeded',
    data: {
      executionId: 'exec-1',
      repoFullName: 'org/repo',
      prNumber: 42,
      budgetUsedUsd: 55,
      budgetLimitUsd: 50,
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'alice',
      title: 'feat: test',
      orgId: 'org-1',
      ...overrides,
    },
  } as unknown as Job;
}

describe('processGitHubIntegrationJob', () => {
  describe('budget.exceeded routing', () => {
    it('posts budget exceeded comment to the PR', async () => {
      await processGitHubIntegrationJob(makeBudgetExceededJob());

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'org',
          repo: 'repo',
          issue_number: 42,
          body: expect.stringContaining('monthly token budget'),
        })
      );
    });

    it('does not attempt comment when repoFullName is invalid', async () => {
      await processGitHubIntegrationJob(
        makeBudgetExceededJob({
          repoFullName: 'invalid-repo-name',
        })
      );

      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('analysis.complete routing', () => {
    it('posts PR review comment on analysis complete', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]); // execution lookup
      // update returning to indicate approval (not already approved)
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(makeAnalysisCompleteJob());

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          body: expect.stringContaining('Pullmint Analysis Results'),
          comments: expect.any(Array),
        })
      );
    });

    it('enqueues analysis.completed notification after posting review', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

      await processGitHubIntegrationJob(makeAnalysisCompleteJob());

      expect(addJob).toHaveBeenCalledWith(
        'notification',
        'analysis.completed',
        expect.objectContaining({
          event: 'analysis.completed',
          repoFullName: 'org/repo',
        })
      );
    });

    it('uses separate Octokit clients for different repositories', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const { getGitHubInstallationClient } = jest.requireMock('@pullmint/shared/github-app') as {
        getGitHubInstallationClient: jest.Mock;
      };

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          executionId: 'exec-1',
          repoFullName: 'org/repo-one',
          prNumber: 101,
        })
      );

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          executionId: 'exec-2',
          repoFullName: 'org/repo-two',
          prNumber: 202,
        })
      );

      expect(getGitHubInstallationClient).toHaveBeenCalledWith('org/repo-one');
      expect(getGitHubInstallationClient).toHaveBeenCalledWith('org/repo-two');
      expect(getGitHubInstallationClient).toHaveBeenCalledTimes(2);
    });

    it('triggers deployment via eventbridge strategy when risk is below threshold', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]); // approval succeeds

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      expect(addJob).toHaveBeenCalledWith(
        'deployment',
        'deployment_approved',
        expect.objectContaining({ executionId: 'exec-1' })
      );
      expect(publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'exec-1', status: 'deploying' })
      );
    });

    it('blocks deployment when risk score exceeds threshold', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 80 }));

      expect(addJob).not.toHaveBeenCalledWith(
        'deployment',
        'deployment_approved',
        expect.any(Object)
      );
      expect(publishExecutionUpdate).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({ status: 'deployment-blocked' })
      );
    });

    it('skips deployment trigger if already approved (idempotency)', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([]); // returning empty = already approved

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      consoleSpy.mockRestore();
      expect(addJob).not.toHaveBeenCalledWith(
        'deployment',
        'deployment_approved',
        expect.any(Object)
      );
      expect(publishEvent).not.toHaveBeenCalled();
    });

    it('auto-approves via PR review when risk is very low', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      // Override auto-approve threshold to be high so risk=5 triggers auto-approve
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '30';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 5 }));

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' })
      );
    });

    it('filters review findings by severity threshold from repo config', async () => {
      mockLimit.mockResolvedValue([
        {
          checkpoints: [],
          metadata: {
            repoConfig: {
              severity_threshold: 'high',
              ignore_paths: [],
              agents: {
                architecture: true,
                security: true,
                performance: true,
                style: true,
              },
            },
          },
        },
      ]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          riskScore: 30,
          findings: [
            {
              type: 'architecture',
              severity: 'info',
              title: 'Info finding',
              description: 'info description',
            },
            {
              type: 'architecture',
              severity: 'medium',
              title: 'Medium finding',
              description: 'medium description',
            },
            {
              type: 'architecture',
              severity: 'high',
              title: 'High finding',
              description: 'high description',
            },
          ],
        })
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          body: expect.stringContaining('High finding'),
        })
      );

      const reviewCall = mockOctokit.rest.pulls.createReview.mock.calls.find(
        ([args]: [{ event: string }]) => args.event === 'COMMENT'
      );
      const reviewBody = reviewCall?.[0].body as string;

      expect(reviewBody).not.toContain('Info finding');
      expect(reviewBody).not.toContain('Medium finding');
    });

    it('uses repo auto_approve_below over environment threshold', async () => {
      mockLimit.mockResolvedValue([
        {
          checkpoints: [],
          metadata: {
            repoConfig: {
              severity_threshold: 'low',
              ignore_paths: [],
              agents: {
                architecture: true,
                security: true,
                performance: true,
                style: true,
              },
              auto_approve_below: 15,
            },
          },
        },
      ]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '5';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 10 }));

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' })
      );
    });

    it('fetches findings from storage when s3Key is provided', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(
        '{"findings":[{"type":"perf","severity":"low","title":"test","description":"desc"}]}'
      );

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'ANALYSIS_RESULTS_BUCKET') return 'test-bucket';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({ riskScore: 30, s3Key: 'exec-1/findings.json' })
      );

      expect(getObject).toHaveBeenCalledWith('test-bucket', 'exec-1/findings.json');
    });

    it('continues with empty findings when storage bucket is not configured', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({ riskScore: 30, s3Key: 'exec-1/findings.json' })
      );

      warnSpy.mockRestore();
      expect(getObject).toHaveBeenCalledWith('pullmint-analysis', 'diffs/exec-1.diff');
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'COMMENT' })
      );
    });

    it('throws when storage returns empty body for s3 findings', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(null);

      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'ANALYSIS_RESULTS_BUCKET') return 'test-bucket';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);

      await expect(
        processGitHubIntegrationJob(
          makeAnalysisCompleteJob({ riskScore: 30, s3Key: 'exec-1/findings.json' })
        )
      ).rejects.toThrow('Empty storage response for key: exec-1/findings.json');
    });

    it('falls back to empty findings when stored findings fail schema validation', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(
        JSON.stringify({
          findings: [{ type: 'perf', severity: 123, title: 'bad', description: 'bad' }],
        })
      );

      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'ANALYSIS_RESULTS_BUCKET') return 'test-bucket';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({ riskScore: 30, s3Key: 'exec-1/findings.json' })
      );

      warnSpy.mockRestore();
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'COMMENT' })
      );
    });

    it('logs auto-approve failures but continues processing', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '30';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockOctokit.rest.pulls.createReview
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('approval failed'));
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 5 }));

      errorSpy.mockRestore();
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'COMMENT' })
      );
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' })
      );
    });

    it('blocks deployment when required checks are not passing', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        if (key === 'DEPLOYMENT_REQUIRE_TESTS') return 'true';
        if (key === 'DEPLOYMENT_REQUIRED_CONTEXTS') return 'ci/test, lint';
        return undefined;
      });

      mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
        data: {
          state: 'failure',
          statuses: [
            { context: 'ci/test', state: 'failure' },
            { context: 'lint', state: 'success' },
          ],
        },
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);

      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      expect(addJob).not.toHaveBeenCalledWith(
        'deployment',
        'deployment_approved',
        expect.any(Object)
      );
      expect(mockOctokit.rest.repos.createDeployment).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(publishExecutionUpdate).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({ status: 'deployment-blocked' })
      );
    });

    it('uses label strategy to add deployment label', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'label';
        if (key === 'DEPLOYMENT_LABEL') return 'deploy-ready';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['deploy-ready'] })
      );
    });

    it('uses deployment strategy to create GitHub deployment', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'deployment';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      expect(mockOctokit.rest.repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'production', ref: 'abc123' })
      );
    });

    it('marks execution as failed and rethrows when deployment trigger throws', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'deployment';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockOctokit.rest.repos.createDeployment.mockRejectedValue(new Error('deployment api error'));
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);
      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };

      await expect(
        processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }))
      ).rejects.toThrow('deployment api error');

      expect(publishExecutionUpdate).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({ status: 'failed' })
      );
    });

    it('falls back to individual env vars when DEPLOYMENT_CONFIG JSON is invalid', async () => {
      (
        jest.requireMock('@pullmint/shared/config') as { getConfigOptional: jest.Mock }
      ).getConfigOptional.mockImplementation((key: string) => {
        if (key === 'DEPLOYMENT_CONFIG') return '{invalid-json';
        if (key === 'DEPLOYMENT_RISK_THRESHOLD') return '60';
        if (key === 'AUTO_APPROVE_RISK_THRESHOLD') return '20';
        if (key === 'DEPLOYMENT_STRATEGY') return 'eventbridge';
        if (key === 'DEPLOYMENT_ENVIRONMENT') return 'production';
        return undefined;
      });

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 30 }));

      errorSpy.mockRestore();
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'COMMENT' })
      );
    });
  });

  describe('inline review comments', () => {
    it('prefixes inline comments with lifecycle badge for new findings', () => {
      const parsedDiff = parseDiff(
        [
          'diff --git a/src/render.ts b/src/render.ts',
          '--- a/src/render.ts',
          '+++ b/src/render.ts',
          '@@ -1,1 +1,20 @@',
          '+new line',
        ].join('\n')
      );

      const payload = buildReviewPayload(
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'abc123',
          baseSha: 'def456',
          author: 'alice',
          title: 'feat: test',
          orgId: 'org-1',
          agentType: 'security',
          findings: [
            {
              type: 'security',
              severity: 'high',
              title: 'New XSS risk',
              description: 'Unescaped output.',
              file: 'src/render.ts',
              line: 10,
              lifecycle: 'new',
              fingerprint: 'abc123abc123abc1',
            },
          ],
          riskScore: 50,
          metadata: { processingTime: 1, tokensUsed: 1, cached: false },
        },
        parsedDiff
      );

      expect(payload.comments[0].body).toContain('🆕 **New**');
    });

    it('prefixes inline comments with persisted badge', () => {
      const parsedDiff = parseDiff(
        [
          'diff --git a/src/render.ts b/src/render.ts',
          '--- a/src/render.ts',
          '+++ b/src/render.ts',
          '@@ -1,1 +1,20 @@',
          '+new line',
        ].join('\n')
      );

      const payload = buildReviewPayload(
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'abc123',
          baseSha: 'def456',
          author: 'alice',
          title: 'feat: test',
          orgId: 'org-1',
          agentType: 'security',
          findings: [
            {
              type: 'security',
              severity: 'high',
              title: 'Persisted issue',
              description: 'Still present.',
              file: 'src/render.ts',
              line: 10,
              lifecycle: 'persisted',
              fingerprint: 'abc123abc123abc2',
            },
          ],
          riskScore: 50,
          metadata: { processingTime: 1, tokensUsed: 1, cached: false },
        },
        parsedDiff
      );

      expect(payload.comments[0].body).toContain('🔄 **Persisted**');
    });

    it('adds resolved findings section to review body when resolvedFindings present', () => {
      const resolved = [
        {
          type: 'security' as const,
          severity: 'high' as const,
          title: 'Fixed SQL injection',
          description: 'Was vulnerable.',
          file: 'src/db.ts',
          lifecycle: 'resolved' as const,
          fingerprint: 'aaa',
        },
      ];

      const payload = buildReviewPayload(
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'abc123',
          baseSha: 'def456',
          author: 'alice',
          title: 'feat: test',
          orgId: 'org-1',
          agentType: 'security',
          findings: [],
          riskScore: 10,
          metadata: { processingTime: 1, tokensUsed: 1, cached: false },
        },
        { files: [], totalFiles: 0, totalAddedLines: 0, totalRemovedLines: 0 },
        { resolvedFindings: resolved }
      );

      expect(payload.body).toContain('✅ Resolved Findings');
      expect(payload.body).toContain('Fixed SQL injection');
    });

    it('includes lifecycle summary line in review body when lifecycleStats present', () => {
      const lifecycleStats = { new: 3, persisted: 5, resolved: 2 };
      const payload = buildReviewPayload(
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'abc123',
          baseSha: 'def456',
          author: 'alice',
          title: 'feat: test',
          orgId: 'org-1',
          agentType: 'security',
          findings: [],
          riskScore: 10,
          metadata: { processingTime: 1, tokensUsed: 1, cached: false },
        },
        { files: [], totalFiles: 0, totalAddedLines: 0, totalRemovedLines: 0 },
        { lifecycleStats }
      );

      expect(payload.body).toContain('3 new, 5 persisted, 2 resolved');
    });

    it('omits lifecycle summary when lifecycleStats not provided', () => {
      const payload = buildReviewPayload(
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'abc123',
          baseSha: 'def456',
          author: 'alice',
          title: 'feat: test',
          orgId: 'org-1',
          agentType: 'security',
          findings: [],
          riskScore: 10,
          metadata: { processingTime: 1, tokensUsed: 1, cached: false },
        },
        { files: [], totalFiles: 0, totalAddedLines: 0, totalRemovedLines: 0 }
      );

      expect(payload.body).not.toContain('new, ');
    });

    it('posts findings with file/line as inline comments', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(
        [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -10,2 +10,4 @@ function test() {',
          ' existing line',
          '+new line',
        ].join('\n')
      );

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          findings: [
            {
              type: 'architecture',
              severity: 'high',
              title: 'Inline finding',
              description: 'Found on changed line',
              file: 'src/foo.ts',
              line: 11,
              suggestion: 'Apply fix',
            },
          ],
        })
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          comments: [expect.objectContaining({ path: 'src/foo.ts', line: 11, side: 'RIGHT' })],
        })
      );
    });

    it('puts findings without file/line in review body', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          findings: [
            {
              type: 'security',
              severity: 'medium',
              title: 'No location finding',
              description: 'General concern',
            },
          ],
        })
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          comments: [],
          body: expect.stringContaining('No location finding'),
        })
      );
    });

    it('puts findings with line outside diff in review body', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(
        [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -10,2 +10,2 @@ function test() {',
          ' existing line',
          '+new line',
        ].join('\n')
      );

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          findings: [
            {
              type: 'performance',
              severity: 'high',
              title: 'Outside diff finding',
              description: 'Line not in diff',
              file: 'src/foo.ts',
              line: 50,
            },
          ],
        })
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          comments: [],
          body: expect.stringContaining('Outside diff finding'),
        })
      );
    });

    it('caps inline comments at MAX_INLINE_COMMENTS', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockResolvedValue(
        [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1,1 +1,120 @@ function test() {',
          ' existing line',
          '+new line',
        ].join('\n')
      );

      const findings = Array.from({ length: 40 }, (_, i) => ({
        type: 'style' as const,
        severity: 'high' as const,
        title: `Finding ${i + 1}`,
        description: `Description ${i + 1}`,
        file: 'src/foo.ts',
        line: i + 1,
      }));

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ findings }));

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          comments: expect.arrayContaining([
            expect.objectContaining({ path: 'src/foo.ts', side: 'RIGHT' }),
          ]),
          body: expect.stringContaining('Finding 40'),
        })
      );

      const reviewCalls = mockOctokit.rest.pulls.createReview.mock.calls;
      const commentCall = reviewCalls
        .map((call) => call[0] as { event?: string; comments?: unknown[] })
        .find((call) => call.event === 'COMMENT');
      expect(commentCall?.comments).toHaveLength(30);
    });

    it('degrades gracefully when diff fetch fails', async () => {
      const { getObject } = jest.requireMock('@pullmint/shared/storage') as {
        getObject: jest.Mock;
      };
      getObject.mockRejectedValue(new Error('diff read failed'));

      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(
        makeAnalysisCompleteJob({
          findings: [
            {
              type: 'architecture',
              severity: 'medium',
              title: 'Fallback finding',
              description: 'Should remain in body',
              file: 'src/foo.ts',
              line: 12,
            },
          ],
        })
      );

      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          comments: [],
          body: expect.stringContaining('Fallback finding'),
        })
      );
    });
  });

  describe('deployment.status routing', () => {
    it('updates execution status and posts comment on deployed', async () => {
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };

      await processGitHubIntegrationJob(makeDeploymentStatusJob('deployed'));

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'exec-1', status: 'monitoring' })
      );
    });

    it('updates execution status and posts comment on failed', async () => {
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };

      await processGitHubIntegrationJob(makeDeploymentStatusJob('failed'));

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'exec-1', status: 'failed' })
      );
    });

    it('skips GitHub comment when status update is rejected (stale event)', async () => {
      mockReturning.mockResolvedValue([]); // update rejected (status already advanced)
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await processGitHubIntegrationJob(makeDeploymentStatusJob('deployed'));

      consoleSpy.mockRestore();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(publishEvent).not.toHaveBeenCalled();
    });

    it('handles deploying status update without posting comment', async () => {
      // For 'deploying' status, the validPriorStatuses branch is taken but no comment posted
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);
      const { publishEvent } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishEvent: jest.Mock;
      };

      await processGitHubIntegrationJob(makeDeploymentStatusJob('deploying'));

      // 'deploying' doesn't trigger a comment
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'exec-1', status: 'deploying' })
      );
    });

    it('updates status for unrecognized deployment status without posting comment', async () => {
      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };

      await processGitHubIntegrationJob(makeDeploymentStatusJob('unknown-status'));

      expect(publishExecutionUpdate).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('unknown job type', () => {
    it('logs a warning and does nothing for unrecognized job names', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const { publishExecutionUpdate } = jest.requireMock('@pullmint/shared/execution-events') as {
        publishExecutionUpdate: jest.Mock;
      };

      await processGitHubIntegrationJob({
        name: 'unknown.type',
        data: { executionId: 'exec-1', repoFullName: 'org/repo', prNumber: 1 },
      } as unknown as Job);

      consoleSpy.mockRestore();
      expect(publishExecutionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('rethrows errors after logging', async () => {
      // Make the DB select throw
      mockDb.select = jest.fn().mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(processGitHubIntegrationJob(makeAnalysisCompleteJob())).rejects.toThrow(
        'DB connection lost'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('helper exports', () => {
    it('renders checkpoint confidence and missing signals when provided', () => {
      const body = buildCommentBody(
        {
          ...(makeAnalysisCompleteJob().data as Record<string, unknown>),
          findings: [],
          metadata: { cached: true, processingTime: 42 },
        } as unknown as Parameters<typeof buildCommentBody>[0],
        {
          checkpoint: {
            confidence: 0.81,
            missingSignals: ['incident_history'],
          } as unknown as NonNullable<Parameters<typeof buildCommentBody>[1]>['checkpoint'],
          dashboardUrl: 'https://dashboard.example.com',
        }
      );

      expect(body).toContain('Confidence:** 81%');
      expect(body).toContain('Missing signals:_ incident_history');
      expect(body).toContain('cached');
    });

    it('renders findings suggestion and non-cached metadata details', () => {
      const body = buildCommentBody({
        ...(makeAnalysisCompleteJob().data as Record<string, unknown>),
        riskScore: 45,
        findings: [
          {
            type: 'architecture',
            severity: 'medium',
            title: 'Layer coupling',
            description: 'Cross-module coupling increased.',
            suggestion: 'Extract a shared boundary.',
          },
        ],
        metadata: { processingTime: 87, tokensUsed: 321 },
      } as unknown as Parameters<typeof buildCommentBody>[0]);

      expect(body).toContain('*Suggestion: Extract a shared boundary.*');
      expect(body).toContain('321 tokens');
    });

    it('renders incremental metadata with rerun agent count', () => {
      const body = buildCommentBody({
        ...(makeAnalysisCompleteJob().data as Record<string, unknown>),
        findings: [],
        metadata: {
          processingTime: 87,
          tokensUsed: 321,
          incremental: true,
          rerunAgents: ['architecture', 'security'],
        },
      } as unknown as Parameters<typeof buildCommentBody>[0]);

      expect(body).toContain('🔄 incremental');
      expect(body).toContain('re-analyzed 2 agents for changed files');
    });

    it('returns medium risk emoji', () => {
      expect(getRiskEmoji('Medium')).toBe('🟡');
    });
  });
});
