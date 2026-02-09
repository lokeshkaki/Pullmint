import { EventBridgeEvent } from 'aws-lambda';

const createOctokitClient = () => ({
  rest: {
    issues: {
      createComment: jest.fn().mockResolvedValue({}),
      addLabels: jest.fn().mockResolvedValue({}),
    },
    pulls: {
      createReview: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockResolvedValue({ data: '' }),
    },
    repos: {
      createDeployment: jest.fn().mockResolvedValue({ data: { id: 321 } }),
      createDeploymentStatus: jest.fn().mockResolvedValue({}),
    },
  },
});

const buildEvent = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    version: '0',
    id: 'event-id',
    detailType: 'analysis.complete',
    source: 'pullmint.agent',
    account: '123',
    time: new Date().toISOString(),
    region: 'us-east-1',
    resources: [],
    detail: {
      prNumber: 12,
      repoFullName: 'owner/repo',
      headSha: 'abc123',
      baseSha: 'def456',
      author: 'dev',
      title: 'Test PR',
      orgId: 'org_1',
      executionId: 'owner/repo#12#abc1234',
      agentType: 'architecture',
      findings: [],
      riskScore: 10,
      metadata: {
        processingTime: 1200,
        tokensUsed: 200,
        cached: false,
      },
      ...overrides,
    },
  }) as EventBridgeEvent<'analysis.complete', any>;

const baseDeploymentConfig = {
  enabled: true,
  strategy: 'label',
  label: 'deploy:staging',
  environment: 'staging',
  riskThreshold: 30,
  autoApprovalThreshold: 30,
};

const setDeploymentConfig = (overrides: Partial<typeof baseDeploymentConfig> = {}) => {
  process.env.PULLMINT_DEPLOYMENT_CONFIG = JSON.stringify({
    ...baseDeploymentConfig,
    ...overrides,
  });
};

describe('GitHub Integration', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.EXECUTIONS_TABLE_NAME = 'test-executions';
    setDeploymentConfig();
  });

  const setupMocks = () => {
    const octokitClient = createOctokitClient();
    jest.doMock('../shared/github-app', () => ({
      getGitHubInstallationClient: jest.fn().mockResolvedValue(octokitClient),
    }));
    jest.doMock('../shared/dynamodb', () => ({
      updateItem: jest.fn().mockResolvedValue(undefined),
    }));

    return octokitClient;
  };

  it('posts comment, auto-approves, and labels deploy when low risk', async () => {
    const octokitClient = setupMocks();
    const { handler } = await import('../index');
    const event = buildEvent();

    await handler(event);

    expect(octokitClient.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokitClient.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(octokitClient.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 12,
      labels: ['deploy:staging'],
    });
  });

  it('skips auto-approval when above threshold', async () => {
    const octokitClient = setupMocks();
    const { handler } = await import('../index');
    const event = buildEvent({
      riskScore: 55,
      metadata: { cached: true, processingTime: 10, tokensUsed: 1 },
    });

    await handler(event);

    expect(octokitClient.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('creates deployment when strategy is deployment', async () => {
    setDeploymentConfig({ strategy: 'deployment' });
    const octokitClient = setupMocks();
    const { handler } = await import('../index');
    const event = buildEvent({
      findings: [
        {
          type: 'architecture',
          severity: 'critical',
          title: 'Critical finding',
          description: 'Desc',
          suggestion: 'Fix',
        },
        {
          type: 'security',
          severity: 'high',
          title: 'High finding',
          description: 'Desc',
        },
        {
          type: 'performance',
          severity: 'medium',
          title: 'Medium finding',
          description: 'Desc',
        },
        {
          type: 'style',
          severity: 'low',
          title: 'Low finding',
          description: 'Desc',
        },
        {
          type: 'architecture',
          severity: 'info',
          title: 'Info finding',
          description: 'Desc',
        },
      ],
      riskScore: 25,
      metadata: { cached: false, processingTime: 500, tokensUsed: 123 },
    });

    await handler(event);

    expect(octokitClient.rest.repos.createDeployment).toHaveBeenCalledTimes(1);
    expect(octokitClient.rest.repos.createDeploymentStatus).toHaveBeenCalledTimes(1);
  });

  it('does not deploy when deployment is disabled', async () => {
    setDeploymentConfig({ enabled: false });
    const octokitClient = setupMocks();
    const { handler } = await import('../index');
    const event = buildEvent({ riskScore: 15 });

    await handler(event);

    expect(octokitClient.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(octokitClient.rest.repos.createDeployment).not.toHaveBeenCalled();
  });

  it('throws when GitHub client is missing during deployment', async () => {
    const octokitClient = setupMocks();
    const { __test__ } = await import('../index');

    __test__.setOctokitClient(undefined);

    await expect(
      __test__.triggerDeployment(buildEvent({ riskScore: 10 }).detail, 'owner', 'repo')
    ).rejects.toThrow('GitHub client not initialized');

    __test__.setOctokitClient(octokitClient as any);
    await expect(
      __test__.triggerDeployment(buildEvent({ riskScore: 10 }).detail, 'owner', 'repo')
    ).resolves.toBeUndefined();
  });

  it('renders all risk levels in comment output', async () => {
    const octokitClient = setupMocks();
    const { handler } = await import('../index');

    await handler(buildEvent({ riskScore: 75 }));
    await handler(buildEvent({ riskScore: 45 }));
    await handler(buildEvent({ riskScore: 15 }));

    expect(octokitClient.rest.issues.createComment).toHaveBeenCalledTimes(3);
  });

  it('surfaces GitHub API failures', async () => {
    const octokitClient = setupMocks();
    octokitClient.rest.issues.createComment.mockRejectedValueOnce(new Error('boom'));
    const { handler } = await import('../index');

    await expect(handler(buildEvent())).rejects.toThrow('boom');
  });

  it('logs auto-approval failures without throwing', async () => {
    const octokitClient = setupMocks();
    octokitClient.rest.pulls.createReview.mockRejectedValueOnce(new Error('review failed'));
    const { handler } = await import('../index');

    await expect(handler(buildEvent({ riskScore: 10 }))).resolves.toBeUndefined();
  });

  it('uses defaults when deployment env vars are missing', async () => {
    jest.resetModules();
    delete process.env.PULLMINT_DEPLOYMENT_CONFIG;
    delete process.env.AUTO_APPROVAL_THRESHOLD;
    delete process.env.DEPLOYMENT_RISK_THRESHOLD;
    delete process.env.DEPLOYMENT_STRATEGY;
    delete process.env.DEPLOYMENT_LABEL;
    delete process.env.DEPLOYMENT_ENVIRONMENT;
    delete process.env.DEPLOYMENT_ENABLED;

    const octokitClient = setupMocks();
    const { handler } = await import('../index');

    await expect(handler(buildEvent({ riskScore: 10 }))).resolves.toBeUndefined();
    expect(octokitClient.rest.issues.addLabels).toHaveBeenCalledTimes(1);
  });

  it('fails fast on invalid config JSON', async () => {
    jest.resetModules();
    process.env.PULLMINT_DEPLOYMENT_CONFIG = '{';

    await expect(import('../index')).rejects.toThrow('Invalid PULLMINT_DEPLOYMENT_CONFIG');
  });

  it('fails fast on invalid threshold values', async () => {
    jest.resetModules();
    setDeploymentConfig({ riskThreshold: 200 });

    await expect(import('../index')).rejects.toThrow('riskThreshold');
  });
});
