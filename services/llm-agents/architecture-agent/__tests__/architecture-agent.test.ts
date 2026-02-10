import type { SQSEvent, SQSRecord } from 'aws-lambda';

jest.mock('../../../shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

jest.mock('../../../shared/secrets', () => ({
  getSecret: jest.fn(),
}));

jest.mock('../../../shared/eventbridge', () => ({
  publishEvent: jest.fn(),
}));

jest.mock('../../../shared/dynamodb', () => ({
  getItem: jest.fn(),
  putItem: jest.fn(),
  updateItem: jest.fn(),
}));

jest.mock('../../../shared/utils', () => ({
  hashContent: jest.fn(),
}));

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn(),
}));

type AnthropicMock = {
  messages: { create: jest.Mock };
};

type OctokitMock = {
  rest: { pulls: { get: jest.Mock } };
};

type HandlerFn = (event: SQSEvent) => Promise<void>;

const getSharedMocks = () => ({
  getGitHubInstallationClient: jest.requireMock('../../../shared/github-app')
    .getGitHubInstallationClient as jest.Mock,
  getSecret: jest.requireMock('../../../shared/secrets').getSecret as jest.Mock,
  publishEvent: jest.requireMock('../../../shared/eventbridge').publishEvent as jest.Mock,
  getItem: jest.requireMock('../../../shared/dynamodb').getItem as jest.Mock,
  putItem: jest.requireMock('../../../shared/dynamodb').putItem as jest.Mock,
  updateItem: jest.requireMock('../../../shared/dynamodb').updateItem as jest.Mock,
  hashContent: jest.requireMock('../../../shared/utils').hashContent as jest.Mock,
});

const loadHandler = async () => {
  jest.resetModules();

  process.env.ANTHROPIC_API_KEY_ARN = 'arn:anthropic';
  process.env.CACHE_TABLE_NAME = 'cache-table';
  process.env.EXECUTIONS_TABLE_NAME = 'executions-table';
  process.env.EVENT_BUS_NAME = 'event-bus';

  const module = await import('../index');
  return module.handler as HandlerFn;
};

const buildRecord = (body: string): SQSRecord => ({
  messageId: 'message-id',
  receiptHandle: 'receipt-handle',
  body,
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '1710000000000',
    SenderId: 'sender-id',
    ApproximateFirstReceiveTimestamp: '1710000000000',
  },
  messageAttributes: {},
  md5OfBody: 'md5',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:queue',
  awsRegion: 'us-east-1',
});

const buildEvent = (detailOverrides?: Record<string, unknown>): SQSEvent => ({
  Records: [
    buildRecord(
      JSON.stringify({
        detail: {
          executionId: 'exec-123',
          prNumber: 42,
          repoFullName: 'owner/repo',
          title: 'Improve architecture',
          ...detailOverrides,
        },
      })
    ),
  ],
});

describe('architecture-agent handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses cached analysis when available', async () => {
    const handler = await loadHandler();

    const anthropicCreate = jest.fn();
    const anthropicConstructor = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
    anthropicConstructor.mockImplementation(
      (): AnthropicMock => ({
        messages: { create: anthropicCreate },
      })
    );

    const diff = 'diff --git a/file.ts b/file.ts\n+const value = 1;';
    const octokitMock: OctokitMock = {
      rest: { pulls: { get: jest.fn().mockResolvedValue({ data: diff }) } },
    };

    const {
      getSecret,
      getGitHubInstallationClient,
      hashContent,
      getItem,
      updateItem,
      publishEvent,
      putItem,
    } = getSharedMocks();

    getSecret.mockResolvedValue('secret');
    getGitHubInstallationClient.mockResolvedValue(octokitMock as never);
    hashContent.mockReturnValue('cache-key');
    getItem.mockResolvedValue({
      findings: [
        {
          type: 'architecture',
          severity: 'low',
          title: 'Minor issue',
          description: 'Details',
          suggestion: 'Adjust',
        },
      ],
      riskScore: 12,
    });
    updateItem.mockResolvedValue(undefined);
    publishEvent.mockResolvedValue(undefined);

    await handler(buildEvent());

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(putItem).not.toHaveBeenCalled();
    expect(updateItem).toHaveBeenCalledWith(
      'executions-table',
      { executionId: 'exec-123' },
      expect.objectContaining({ status: 'analyzing' })
    );
    expect(publishEvent).toHaveBeenCalledWith(
      'event-bus',
      'pullmint.agent',
      'analysis.complete',
      expect.objectContaining({
        executionId: 'exec-123',
        riskScore: 12,
        metadata: expect.objectContaining({ cached: true }),
      })
    );
  });

  it('runs LLM analysis and caches results when not cached', async () => {
    const handler = await loadHandler();

    const anthropicCreate = jest.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            findings: [
              {
                type: 'security',
                severity: 'high',
                title: 'Issue',
                description: 'Risk',
                suggestion: 'Fix',
              },
            ],
            riskScore: 42,
            summary: 'Ok',
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const anthropicConstructor = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
    anthropicConstructor.mockImplementation(
      (): AnthropicMock => ({
        messages: { create: anthropicCreate },
      })
    );

    const longDiff = 'a'.repeat(9000);
    const octokitMock: OctokitMock = {
      rest: { pulls: { get: jest.fn().mockResolvedValue({ data: longDiff }) } },
    };

    const {
      getSecret,
      getGitHubInstallationClient,
      hashContent,
      getItem,
      updateItem,
      publishEvent,
      putItem,
    } = getSharedMocks();

    getSecret.mockResolvedValue('secret');
    getGitHubInstallationClient.mockResolvedValue(octokitMock as never);
    hashContent.mockReturnValue('cache-key');
    getItem.mockResolvedValue(null);
    updateItem.mockResolvedValue(undefined);
    publishEvent.mockResolvedValue(undefined);
    putItem.mockResolvedValue(undefined);

    await handler(buildEvent());

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const anthropicArgs = anthropicCreate.mock.calls[0][0];
    expect(anthropicArgs.messages[0].content).toContain('[... diff truncated ...]');

    expect(putItem).toHaveBeenCalledWith(
      'cache-table',
      expect.objectContaining({
        cacheKey: 'cache-key',
        riskScore: 42,
        findings: expect.any(Array),
        ttl: expect.any(Number),
      })
    );

    expect(publishEvent).toHaveBeenCalledWith(
      'event-bus',
      'pullmint.agent',
      'analysis.complete',
      expect.objectContaining({
        riskScore: 42,
        metadata: expect.objectContaining({ cached: false, tokensUsed: 30 }),
      })
    );
  });

  it('falls back to default analysis on invalid LLM response', async () => {
    const handler = await loadHandler();

    const anthropicCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'invalid-json{' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const anthropicConstructor = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
    anthropicConstructor.mockImplementation(
      (): AnthropicMock => ({
        messages: { create: anthropicCreate },
      })
    );

    const diff = 'diff --git a/file.ts b/file.ts\n+const value = 1;';
    const octokitMock: OctokitMock = {
      rest: { pulls: { get: jest.fn().mockResolvedValue({ data: diff }) } },
    };

    const {
      getSecret,
      getGitHubInstallationClient,
      hashContent,
      getItem,
      updateItem,
      publishEvent,
      putItem,
    } = getSharedMocks();

    getSecret.mockResolvedValue('secret');
    getGitHubInstallationClient.mockResolvedValue(octokitMock as never);
    hashContent.mockReturnValue('cache-key');
    getItem.mockResolvedValue(null);
    updateItem.mockResolvedValue(undefined);
    publishEvent.mockResolvedValue(undefined);
    putItem.mockResolvedValue(undefined);

    await handler(buildEvent());

    expect(updateItem).toHaveBeenCalledWith(
      'executions-table',
      { executionId: 'exec-123' },
      expect.objectContaining({ riskScore: 50 })
    );

    expect(publishEvent).toHaveBeenCalledWith(
      'event-bus',
      'pullmint.agent',
      'analysis.complete',
      expect.objectContaining({ riskScore: 50 })
    );
  });

  it('marks the execution as failed when processing errors occur', async () => {
    const handler = await loadHandler();

    const anthropicConstructor = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
    anthropicConstructor.mockImplementation(
      (): AnthropicMock => ({
        messages: { create: jest.fn() },
      })
    );

    const { getSecret, getGitHubInstallationClient, updateItem } = getSharedMocks();

    getSecret.mockResolvedValue('secret');
    getGitHubInstallationClient.mockRejectedValue(new Error('Auth failure'));
    updateItem.mockResolvedValue(undefined);

    await expect(handler(buildEvent())).rejects.toThrow('Auth failure');

    expect(updateItem).toHaveBeenCalledWith(
      'executions-table',
      { executionId: 'exec-123' },
      expect.objectContaining({ status: 'failed', error: 'Auth failure' })
    );
  });

  it('rejects invalid payloads', async () => {
    const handler = await loadHandler();

    const anthropicConstructor = jest.requireMock('@anthropic-ai/sdk').default as jest.Mock;
    anthropicConstructor.mockImplementation(
      (): AnthropicMock => ({
        messages: { create: jest.fn() },
      })
    );

    const event: SQSEvent = {
      Records: [buildRecord(JSON.stringify({}))],
    };

    await expect(handler(event)).rejects.toThrow('Invalid PR event payload');
  });
});
