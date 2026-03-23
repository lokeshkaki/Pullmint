import {
  buildCommentBody,
  getRiskEmoji,
  processGitHubIntegrationJob,
} from '../src/processors/github-integration';
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

describe('processGitHubIntegrationJob', () => {
  describe('analysis.complete routing', () => {
    it('posts PR comment on analysis complete', async () => {
      mockLimit.mockResolvedValue([{ checkpoints: [] }]); // execution lookup
      // update returning to indicate approval (not already approved)
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      await processGitHubIntegrationJob(makeAnalysisCompleteJob());

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
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

      expect(addJob).not.toHaveBeenCalled();
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
      expect(addJob).not.toHaveBeenCalled();
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
      expect(getObject).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
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
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
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

      mockOctokit.rest.pulls.createReview.mockRejectedValue(new Error('approval failed'));
      mockLimit.mockResolvedValue([{ checkpoints: [] }]);
      mockReturning.mockResolvedValue([{ executionId: 'exec-1' }]);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await processGitHubIntegrationJob(makeAnalysisCompleteJob({ riskScore: 5 }));

      errorSpy.mockRestore();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalled();
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

      expect(addJob).not.toHaveBeenCalled();
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
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
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
      expect(body).toContain('(cached)');
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

      expect(body).toContain('_Suggestion:_ Extract a shared boundary.');
      expect(body).toContain('using 321 tokens');
    });

    it('returns medium risk emoji', () => {
      expect(getRiskEmoji('Medium')).toBe('🟡');
    });
  });
});
