import { handler, buildCommentBody, getRiskEmoji, getRiskLevel } from '../index';
import { publishEvent } from '../../shared/eventbridge';
import { getItem, updateItem, updateItemConditional } from '../../shared/dynamodb';
import { getGitHubInstallationClient } from '../../shared/github-app';

jest.mock('../../shared/eventbridge', () => ({
  publishEvent: jest.fn(),
}));

jest.mock('../../shared/dynamodb', () => ({
  getItem: jest.fn(),
  updateItem: jest.fn(),
  updateItemConditional: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => {
  // Capture the send mock inside the factory to avoid jest.mock hoisting issues
  const s3SendFn = jest.fn().mockResolvedValue({});
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: s3SendFn })),
    GetObjectCommand: jest.fn().mockImplementation((input: unknown) => input),
    __s3SendFn: s3SendFn,
  };
});

const getS3SendMock = () =>
  (jest.requireMock('@aws-sdk/client-s3') as { __s3SendFn: jest.Mock }).__s3SendFn;

const createComment = jest.fn();
const createReview = jest.fn();
const addLabels = jest.fn();
const createDeployment = jest.fn();
const getCombinedStatusForRef = jest.fn();

jest.mock('../../shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

const invokeHandler = (event: Parameters<typeof handler>[0]) =>
  handler(event, {} as any, () => undefined);

describe('GitHub Integration', () => {
  const baseDetail = {
    executionId: 'exec-123',
    prNumber: 42,
    repoFullName: 'owner/repo',
    headSha: 'abc123',
    baseSha: 'def456',
    author: 'octocat',
    title: 'Add feature',
    orgId: 'org_1',
    riskScore: 10,
    findings: [],
    agentType: 'architecture' as const,
    metadata: {
      processingTime: 1200,
      tokensUsed: 200,
      cached: false,
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();

    (getGitHubInstallationClient as jest.Mock).mockResolvedValue({
      rest: {
        issues: {
          createComment,
          addLabels,
        },
        pulls: {
          createReview,
        },
        repos: {
          createDeployment,
          getCombinedStatusForRef,
        },
      },
    });

    getCombinedStatusForRef.mockResolvedValue({
      data: { state: 'success', statuses: [] },
    });

    (updateItemConditional as jest.Mock).mockResolvedValue(undefined);
    (getItem as jest.Mock).mockResolvedValue(null);
    getS3SendMock().mockResolvedValue({});

    process.env.EXECUTIONS_TABLE_NAME = 'exec-table';
    process.env.EVENT_BUS_NAME = 'test-bus';
    process.env.ANALYSIS_RESULTS_BUCKET = 'analysis-bucket';
    process.env.DEPLOYMENT_RISK_THRESHOLD = '30';
    process.env.AUTO_APPROVE_RISK_THRESHOLD = '30';
    process.env.DEPLOYMENT_ENVIRONMENT = 'staging';
    process.env.DEPLOYMENT_LABEL = 'deploy:staging';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'false';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = '';
  });

  it('posts analysis results and approves low risk PRs', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(addLabels).toHaveBeenCalledTimes(1);
    expect(updateItemConditional).toHaveBeenCalled();
  });

  it('skips deployment for high risk scores', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_RISK_THRESHOLD = '5';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, riskScore: 99 },
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
  });

  it('publishes deployment approval for eventbridge strategy', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.review',
      'deployment_approved',
      expect.objectContaining({
        executionId: baseDetail.executionId,
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
      })
    );
  });

  it('uses default config values when env is unset', async () => {
    delete process.env.DEPLOYMENT_RISK_THRESHOLD;
    delete process.env.AUTO_APPROVE_RISK_THRESHOLD;
    delete process.env.DEPLOYMENT_STRATEGY;
    delete process.env.DEPLOYMENT_LABEL;
    delete process.env.DEPLOYMENT_ENVIRONMENT;
    delete process.env.DEPLOYMENT_REQUIRE_TESTS;
    delete process.env.DEPLOYMENT_REQUIRED_CONTEXTS;

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.review',
      'deployment_approved',
      expect.objectContaining({
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
      })
    );
  });

  it('falls back to env vars on invalid deployment config JSON', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.DEPLOYMENT_CONFIG = '{invalid-json';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    delete process.env.DEPLOYMENT_CONFIG;
  });

  it('uses required contexts from deployment config', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_CONFIG = JSON.stringify({
      deploymentRequiredContexts: ['ci', 'security'],
    });

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: {
        state: 'success',
        statuses: [
          { context: 'ci', state: 'success' },
          { context: 'security', state: 'success' },
        ],
      },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalled();
    delete process.env.DEPLOYMENT_CONFIG;
  });

  it('creates GitHub deployment when strategy is deployment', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'deployment';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'staging',
        ref: baseDetail.headSha,
      })
    );
  });

  it('records deployment trigger failures with non-error throws', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'deployment';
    createDeployment.mockRejectedValueOnce('boom');

    await expect(
      invokeHandler({
        'detail-type': 'analysis.complete',
        detail: baseDetail,
      } as any)
    ).rejects.toBe('boom');

    expect(updateItem).toHaveBeenCalledWith(
      'exec-table',
      { executionId: baseDetail.executionId },
      expect.objectContaining({
        status: 'failed',
        deploymentStatus: 'failed',
        deploymentMessage: 'Deployment trigger failed: boom',
      })
    );
  });

  it('skips deployment when approval already recorded', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    (updateItemConditional as jest.Mock).mockRejectedValueOnce({
      name: 'ConditionalCheckFailedException',
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
    expect(createDeployment).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('surfaces conditional update failures', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    (updateItemConditional as jest.Mock).mockRejectedValueOnce(new Error('ddb'));

    await expect(
      invokeHandler({
        'detail-type': 'analysis.complete',
        detail: baseDetail,
      } as any)
    ).rejects.toThrow('ddb');
  });

  it('logs and continues when auto-approve fails', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    createReview.mockRejectedValueOnce(new Error('review failed'));

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(createReview).toHaveBeenCalled();
    expect(addLabels).toHaveBeenCalled();
  });

  it('updates deployment status and comments on completion', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';

    await invokeHandler({
      'detail-type': 'deployment.status',
      detail: {
        ...baseDetail,
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
        deploymentStatus: 'deployed',
        message: 'All good',
      },
    } as any);

    expect(updateItemConditional).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('updates deployment status without commenting while deploying', async () => {
    await invokeHandler({
      'detail-type': 'deployment.status',
      detail: {
        ...baseDetail,
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
        deploymentStatus: 'deploying',
      },
    } as any);

    expect(updateItemConditional).toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('should not overwrite monitoring/confirmed/rolled-back status with deployed', async () => {
    (updateItemConditional as jest.Mock).mockRejectedValueOnce({
      name: 'ConditionalCheckFailedException',
      message: 'Condition not met',
      $metadata: {},
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Should not throw — should log and continue
    await expect(
      invokeHandler({
        'detail-type': 'deployment.status',
        detail: {
          ...baseDetail,
          deploymentEnvironment: 'staging',
          deploymentStrategy: 'eventbridge',
          deploymentStatus: 'deployed',
        },
      } as any)
    ).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Status already advanced past deployed')
    );
    // Should not post a comment when status update was skipped
    expect(createComment).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should not overwrite terminal status with deploying', async () => {
    (updateItemConditional as jest.Mock).mockRejectedValueOnce({
      name: 'ConditionalCheckFailedException',
      message: 'Condition not met',
      $metadata: {},
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      invokeHandler({
        'detail-type': 'deployment.status',
        detail: {
          ...baseDetail,
          deploymentEnvironment: 'staging',
          deploymentStrategy: 'eventbridge',
          deploymentStatus: 'deploying',
        },
      } as any)
    ).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Status already advanced past deploying')
    );
    warnSpy.mockRestore();
  });

  it('re-throws non-conditional errors during deployment status update', async () => {
    (updateItemConditional as jest.Mock).mockRejectedValueOnce(new Error('ddb network error'));

    await expect(
      invokeHandler({
        'detail-type': 'deployment.status',
        detail: {
          ...baseDetail,
          deploymentEnvironment: 'staging',
          deploymentStrategy: 'eventbridge',
          deploymentStatus: 'deployed',
        },
      } as any)
    ).rejects.toThrow('ddb network error');
  });

  it('uses unconditional update for unrecognized deployment statuses', async () => {
    await invokeHandler({
      'detail-type': 'deployment.status',
      detail: {
        ...baseDetail,
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
        deploymentStatus: 'pending',
      },
    } as any);

    expect(updateItem).toHaveBeenCalled();
    expect(updateItemConditional).not.toHaveBeenCalled();
  });

  it('comments on failed deployments without a message', async () => {
    await invokeHandler({
      'detail-type': 'deployment.status',
      detail: {
        ...baseDetail,
        deploymentEnvironment: 'staging',
        deploymentStrategy: 'eventbridge',
        deploymentStatus: 'failed',
      },
    } as any);

    expect(updateItemConditional).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('blocks deployment when tests are required but missing', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'pending', statuses: [] },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
    expect(updateItemConditional).not.toHaveBeenCalled();
  });

  it('updates execution to deployment-blocked when risk score exceeds threshold', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_RISK_THRESHOLD = '5';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, riskScore: 99 },
    } as any);

    expect(updateItem).toHaveBeenCalledWith(
      'exec-table',
      { executionId: baseDetail.executionId },
      expect.objectContaining({
        status: 'deployment-blocked',
        deploymentMessage: expect.stringContaining('99'),
      })
    );
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('updates execution to deployment-blocked when required checks are not passing', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'failure', statuses: [] },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(updateItem).toHaveBeenCalledWith(
      'exec-table',
      { executionId: baseDetail.executionId },
      expect.objectContaining({
        status: 'deployment-blocked',
        deploymentMessage: 'Tests required but not passing',
      })
    );
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('testsPassed===undefined blocks deployment and logs missing field', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'failure', statuses: [] },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, testsPassed: undefined },
    } as any);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('undefined (missing from analysis result)')
    );
    expect(publishEvent).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('testsPassed===false blocks deployment and logs false value', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'failure', statuses: [] },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, testsPassed: false },
    } as any);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('testsPassed=false'));
    expect(publishEvent).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('blocks deployment when combined status is not success', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = '';
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'failure', statuses: [] },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('allows deployment when required contexts are successful', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = 'ci,security';

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: {
        state: 'success',
        statuses: [
          { context: 'ci', state: 'success' },
          { context: 'security', state: 'success' },
        ],
      },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalled();
  });

  it('blocks deployment when required contexts are missing', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = 'ci,security';

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: {
        state: 'success',
        statuses: [{ context: 'ci', state: 'success' }],
      },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('blocks deployment when statuses are missing', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = 'ci';

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { state: 'success' },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('ignores malformed status entries when checking contexts', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';
    process.env.DEPLOYMENT_REQUIRED_CONTEXTS = 'ci';

    getCombinedStatusForRef.mockResolvedValueOnce({
      data: {
        state: 'success',
        statuses: [{ context: 'ci', state: 'success' }, { state: 'success' }, { context: 'lint' }],
      },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).toHaveBeenCalled();
  });

  it('ignores unknown event detail types', async () => {
    await invokeHandler({
      'detail-type': 'unknown.event',
      detail: baseDetail,
    } as any);

    expect(createComment).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('throws when event bus name is missing for eventbridge strategy', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    delete process.env.EVENT_BUS_NAME;

    await expect(
      invokeHandler({
        'detail-type': 'analysis.complete',
        detail: baseDetail,
      } as any)
    ).rejects.toThrow('EVENT_BUS_NAME is required for eventbridge deployment strategy');
  });

  it('surfaces handler errors', async () => {
    delete process.env.EXECUTIONS_TABLE_NAME;

    await expect(
      invokeHandler({
        'detail-type': 'analysis.complete',
        detail: baseDetail,
      } as any)
    ).rejects.toThrow('EXECUTIONS_TABLE_NAME is required');
  });

  it('fetches findings from S3 when s3Key is present in event', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    const s3Findings = [
      {
        type: 'security',
        severity: 'high',
        title: 'S3 Finding',
        description: 'From S3',
        suggestion: 'Fix',
      },
    ];
    getS3SendMock().mockResolvedValueOnce({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({ executionId: 'exec-123', riskScore: 10, findings: s3Findings })
          ),
      },
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, s3Key: 'executions/exec-123/analysis.json', findings: undefined },
    } as any);

    const s3Send = getS3SendMock();
    expect(s3Send).toHaveBeenCalledTimes(1);
    const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
      GetObjectCommand: jest.Mock;
    };
    expect(GetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'analysis-bucket',
        Key: 'executions/exec-123/analysis.json',
      })
    );
    // PR comment should include the finding fetched from S3
    const commentBody = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(commentBody).toContain('S3 Finding');
  });

  it('uses inline findings when s3Key is absent (backward compat)', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    const inlineFinding = {
      type: 'architecture' as const,
      severity: 'low' as const,
      title: 'Inline Finding',
      description: 'From event',
    };

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, findings: [inlineFinding] },
    } as any);

    expect(getS3SendMock()).not.toHaveBeenCalled();
    const commentBody = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(commentBody).toContain('Inline Finding');
  });

  it('returns empty findings when ANALYSIS_RESULTS_BUCKET is not configured', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    delete process.env.ANALYSIS_RESULTS_BUCKET;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, s3Key: 'executions/exec-123/analysis.json', findings: undefined },
    } as any);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ANALYSIS_RESULTS_BUCKET not configured')
    );
    expect(getS3SendMock()).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    process.env.ANALYSIS_RESULTS_BUCKET = 'analysis-bucket';
  });

  it('handles missing findings and missing s3Key gracefully', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: { ...baseDetail, findings: undefined, s3Key: undefined },
    } as any);

    expect(getS3SendMock()).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    const commentBody = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(commentBody).toContain('No Issues Found');
  });

  it('throws when S3 returns empty body for analysis results', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    getS3SendMock().mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('') },
    });

    await expect(
      invokeHandler({
        'detail-type': 'analysis.complete',
        detail: { ...baseDetail, s3Key: 'executions/exec-123/analysis.json', findings: undefined },
      } as any)
    ).rejects.toThrow('Empty S3 response for key: executions/exec-123/analysis.json');
  });

  it('fetches execution checkpoint and includes confidence in PR comment', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'label';
    (getItem as jest.Mock).mockResolvedValue({
      checkpoints: [
        {
          type: 'analysis',
          score: 25,
          confidence: 0.67,
          missingSignals: [],
          signals: [],
          decision: 'approved',
          reason: 'ok',
          evaluatedAt: Date.now(),
        },
      ],
    });

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(createComment).toHaveBeenCalledTimes(1);
    const commentBody = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(commentBody).toContain('**Confidence:** 67%');
  });
});

describe('GitHub Integration Helpers', () => {
  it('builds a comment body with risk score', () => {
    const result = buildCommentBody({
      executionId: 'exec-1',
      prNumber: 1,
      repoFullName: 'owner/repo',
      headSha: 'abc',
      baseSha: 'def',
      author: 'octocat',
      title: 'Test',
      orgId: 'org_1',
      riskScore: 55,
      findings: [],
      agentType: 'architecture',
      metadata: { processingTime: 100, tokensUsed: 10, cached: true },
    });

    expect(result).toContain('Risk Score');
    expect(result).toContain('55/100');
  });

  it('builds a comment body with critical and high findings', () => {
    const result = buildCommentBody({
      executionId: 'exec-2',
      prNumber: 2,
      repoFullName: 'owner/repo',
      headSha: 'abc',
      baseSha: 'def',
      author: 'octocat',
      title: 'Test',
      orgId: 'org_1',
      riskScore: 20,
      findings: [
        {
          type: 'architecture',
          severity: 'critical',
          title: 'Critical gap',
          description: 'Major issue.',
          suggestion: 'Fix it.',
        },
        {
          type: 'performance',
          severity: 'high',
          title: 'Hot spot',
          description: 'High coupling detected.',
          suggestion: 'Extract module.',
        },
      ],
      agentType: 'architecture',
      metadata: { processingTime: 100, tokensUsed: 10, cached: false },
    });

    expect(result).toContain('Findings (2)');
    expect(result).toContain('Critical gap');
    expect(result).toContain('Hot spot');
  });

  it('builds a comment body with medium, low, and info findings', () => {
    const result = buildCommentBody({
      executionId: 'exec-3',
      prNumber: 3,
      repoFullName: 'owner/repo',
      headSha: 'abc',
      baseSha: 'def',
      author: 'octocat',
      title: 'Test',
      orgId: 'org_1',
      riskScore: 35,
      findings: [
        {
          type: 'architecture',
          severity: 'medium',
          title: 'Medium risk',
          description: 'Moderate issue.',
        },
        {
          type: 'style',
          severity: 'low',
          title: 'Style nit',
          description: 'Minor issue.',
        },
        {
          type: 'security',
          severity: 'info',
          title: 'Info note',
          description: 'Informational note.',
        },
      ],
      agentType: 'architecture',
      metadata: { processingTime: 80, tokensUsed: 8, cached: true },
    });

    expect(result).toContain('Findings (3)');
    expect(result).toContain('Medium risk');
    expect(result).toContain('Style nit');
    expect(result).toContain('Info note');
  });

  it('maps risk levels and emojis correctly', () => {
    expect(getRiskLevel(10)).toBe('Low');
    expect(getRiskLevel(50)).toBe('Medium');
    expect(getRiskLevel(80)).toBe('High');
    expect(getRiskEmoji('Low')).toBe('🟢');
    expect(getRiskEmoji('Medium')).toBe('🟡');
    expect(getRiskEmoji('High')).toBe('🔴');
  });

  it('includes confidence percentage when checkpoint is provided with no missing signals', () => {
    const result = buildCommentBody(
      {
        executionId: 'exec-cp',
        prNumber: 4,
        repoFullName: 'owner/repo',
        headSha: 'abc',
        baseSha: 'def',
        author: 'octocat',
        title: 'Test',
        orgId: 'org_1',
        riskScore: 25,
        findings: [],
        agentType: 'architecture',
        metadata: { processingTime: 100, tokensUsed: 10, cached: false },
      },
      {
        checkpoint: {
          type: 'analysis',
          score: 25,
          confidence: 0.5,
          missingSignals: [],
          signals: [],
          decision: 'approved',
          reason: 'ok',
          evaluatedAt: 1234,
        },
        dashboardUrl: '',
      }
    );

    expect(result).toContain('**Confidence:** 50%');
    expect(result).not.toContain('Missing signals');
  });

  it('includes missing signals section when checkpoint has missing signals', () => {
    const result = buildCommentBody(
      {
        executionId: 'exec-ms',
        prNumber: 5,
        repoFullName: 'owner/repo',
        headSha: 'abc',
        baseSha: 'def',
        author: 'octocat',
        title: 'Test',
        orgId: 'org_1',
        riskScore: 25,
        findings: [],
        agentType: 'architecture',
        metadata: { processingTime: 100, tokensUsed: 10, cached: false },
      },
      {
        checkpoint: {
          type: 'analysis',
          score: 25,
          confidence: 0.33,
          missingSignals: ['ci.result', 'author_history'],
          signals: [],
          decision: 'approved',
          reason: 'ok',
          evaluatedAt: 1234,
        },
        dashboardUrl: '',
      }
    );

    expect(result).toContain('ci.result');
    expect(result).toContain('author_history');
  });

  it('uses dashboard URL in footer link when dashboardUrl is provided', () => {
    const result = buildCommentBody(
      {
        executionId: 'exec-url',
        prNumber: 6,
        repoFullName: 'owner/repo',
        headSha: 'abc',
        baseSha: 'def',
        author: 'octocat',
        title: 'Test',
        orgId: 'org_1',
        riskScore: 25,
        findings: [],
        agentType: 'architecture',
        metadata: { processingTime: 100, tokensUsed: 10, cached: false },
      },
      {
        checkpoint: {
          type: 'analysis',
          score: 25,
          confidence: 0.5,
          missingSignals: [],
          signals: [],
          decision: 'approved',
          reason: 'ok',
          evaluatedAt: 1234,
        },
        dashboardUrl: 'https://dash.example.com',
      }
    );

    expect(result).toContain('https://dash.example.com/executions/exec-url');
  });
});
