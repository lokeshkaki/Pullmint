import { handler, buildCommentBody, getRiskEmoji, getRiskLevel } from '../index';
import { publishEvent } from '../../shared/eventbridge';
import { updateItem } from '../../shared/dynamodb';
import { getGitHubInstallationClient } from '../../shared/github-app';

jest.mock('../../shared/eventbridge', () => ({
  publishEvent: jest.fn(),
}));

jest.mock('../../shared/dynamodb', () => ({
  updateItem: jest.fn(),
}));

const createComment = jest.fn();
const createReview = jest.fn();
const addLabels = jest.fn();
const createDeployment = jest.fn();

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
    jest.clearAllMocks();

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
        },
      },
    });

    process.env.EXECUTIONS_TABLE_NAME = 'exec-table';
    process.env.EVENT_BUS_NAME = 'test-bus';
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
    expect(updateItem).toHaveBeenCalled();
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

    expect(updateItem).toHaveBeenCalled();
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

    expect(updateItem).toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
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

    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('blocks deployment when tests are required but missing', async () => {
    process.env.DEPLOYMENT_STRATEGY = 'eventbridge';
    process.env.DEPLOYMENT_REQUIRE_TESTS = 'true';

    await invokeHandler({
      'detail-type': 'analysis.complete',
      detail: baseDetail,
    } as any);

    expect(publishEvent).not.toHaveBeenCalled();
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
});
