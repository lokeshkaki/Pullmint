import type { SQSEvent } from 'aws-lambda';

// Mock shared modules
jest.mock('../../shared/dynamodb', () => ({
  getItem: jest.fn(),
  updateItem: jest.fn(),
  putItem: jest.fn(),
  atomicDecrement: jest.fn(),
}));

jest.mock('../../shared/secrets', () => ({
  getSecret: jest.fn().mockResolvedValue('test-api-key'),
}));

const mockOctokitInstance: {
  rest: {
    repos: { get: jest.fn; getContent: jest.fn };
    pulls: { listFiles: jest.fn };
  };
} = {
  rest: {
    repos: { get: jest.fn(), getContent: jest.fn() },
    pulls: { listFiles: jest.fn() },
  },
};

jest.mock('../../shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn().mockResolvedValue(mockOctokitInstance),
}));

// Mock repo-indexer local modules
jest.mock('../git-history', () => ({
  fetchFileTree: jest.fn(),
  fetchFileCommitHistory: jest.fn(),
  aggregateAuthorProfiles: jest.fn().mockReturnValue([]),
}));

jest.mock('../module-detector', () => ({
  detectModules: jest.fn().mockReturnValue([]),
}));

jest.mock('../narrative-generator', () => ({
  generateModuleNarrative: jest.fn().mockResolvedValue('Test narrative'),
}));

jest.mock('../embeddings', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}));

jest.mock('../opensearch-client', () => ({
  upsertNarrative: jest.fn().mockResolvedValue(undefined),
}));

// Mock AWS SDK direct usage (handler creates its own docClient and sqsClient)
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send })) },
    UpdateCommand: jest.fn((input: unknown) => input),
    __mockDocClientSend: send,
  };
});

jest.mock('@aws-sdk/client-sqs', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    SQSClient: jest.fn(() => ({ send })),
    SendMessageCommand: jest.fn((input: unknown) => input),
    __mockSqsSend: send,
  };
});

type HandlerFn = (event: SQSEvent) => Promise<void>;

const getMocks = () => ({
  updateItem: jest.requireMock('../../shared/dynamodb').updateItem as jest.Mock,
  putItem: jest.requireMock('../../shared/dynamodb').putItem as jest.Mock,
  getItem: jest.requireMock('../../shared/dynamodb').getItem as jest.Mock,
  atomicDecrement: jest.requireMock('../../shared/dynamodb').atomicDecrement as jest.Mock,
  fetchFileTree: jest.requireMock('../git-history').fetchFileTree as jest.Mock,
  fetchFileCommitHistory: jest.requireMock('../git-history').fetchFileCommitHistory as jest.Mock,
  detectModules: jest.requireMock('../module-detector').detectModules as jest.Mock,
  docClientSend: jest.requireMock('@aws-sdk/lib-dynamodb').__mockDocClientSend as jest.Mock,
  sqsSend: jest.requireMock('@aws-sdk/client-sqs').__mockSqsSend as jest.Mock,
});

const loadHandler = async (): Promise<HandlerFn> => {
  jest.resetModules();
  process.env.REPO_REGISTRY_TABLE_NAME = 'registry-table';
  process.env.FILE_KNOWLEDGE_TABLE_NAME = 'file-knowledge-table';
  process.env.AUTHOR_PROFILES_TABLE_NAME = 'author-profiles-table';
  process.env.MODULE_NARRATIVES_TABLE_NAME = 'module-narratives-table';
  process.env.EXECUTIONS_TABLE_NAME = 'executions-table';
  process.env.ANALYSIS_QUEUE_URL = 'https://sqs.example.com/queue';
  process.env.ONBOARDING_QUEUE_URL = 'https://sqs.example.com/onboarding-queue';
  process.env.OPENSEARCH_ENDPOINT = 'https://os.example.com';
  process.env.ANTHROPIC_API_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:key';
  const module = await import('../index');
  return module.handler as HandlerFn;
};

function makeEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify(body),
        messageId: '1',
        receiptHandle: '1',
        attributes: {} as never,
        messageAttributes: {},
        md5OfBody: '',
        eventSource: '',
        eventSourceARN: '',
        awsRegion: '',
      },
    ],
  };
}

describe('handler — full-index mode', () => {
  it('writes indexing status and marks indexed when no modules found', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mockOctokitInstance.rest.repos.get.mockResolvedValue({
      data: { default_branch: 'main' },
    });
    mocks.fetchFileTree.mockResolvedValue(['src/auth/index.ts']);
    mocks.detectModules.mockReturnValue([]);
    mocks.updateItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);

    await handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }));

    // First call: set indexing status
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      expect.objectContaining({ indexingStatus: 'indexing' })
    );
    // Should eventually mark as indexed (no modules → immediate indexed)
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      expect.objectContaining({ indexingStatus: 'indexed', contextVersion: 1 })
    );
  });

  it('publishes batch SQS messages when modules are detected', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mockOctokitInstance.rest.repos.get.mockResolvedValue({
      data: { default_branch: 'main' },
    });
    mocks.fetchFileTree.mockResolvedValue([
      'src/auth/index.ts',
      'src/auth/middleware.ts',
      'src/auth/utils.ts',
    ]);
    mocks.detectModules.mockReturnValue([
      {
        modulePath: 'src/auth',
        entryPoint: 'src/auth/index.ts',
        files: ['src/auth/index.ts', 'src/auth/middleware.ts', 'src/auth/utils.ts'],
      },
    ]);
    mocks.updateItem.mockResolvedValue(undefined);

    await handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }));

    // Should write pendingBatches = 1 (one batch for one module group)
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      { pendingBatches: 1 }
    );
    // SQS send called for the batch message
    expect(mocks.sqsSend).toHaveBeenCalled();
  });

  it('writes file metrics and author profiles from commit history', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();
    const aggregateProfiles = jest.requireMock('../git-history')
      .aggregateAuthorProfiles as jest.Mock;

    mockOctokitInstance.rest.repos.get.mockResolvedValue({
      data: { default_branch: 'main' },
    });
    mocks.fetchFileTree.mockResolvedValue(['src/auth/index.ts']);
    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/auth/index.ts',
      churnRate30d: 5,
      churnRate90d: 12,
      bugFixCommitCount30d: 2,
      authors: ['alice', 'bob'],
      lastCommitSha: 'sha123',
    });
    aggregateProfiles.mockReturnValue([
      {
        repoFullName: 'org/repo',
        authorLogin: 'alice',
        rollbackRate: 0,
        mergeCount30d: 3,
        avgRiskScore: 0,
        frequentFiles: ['src/auth/index.ts'],
      },
    ]);
    mocks.detectModules.mockReturnValue([]);
    mocks.updateItem.mockResolvedValue(undefined);
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);

    await handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }));

    // File metrics written
    expect(mocks.putItem).toHaveBeenCalledWith(
      'file-knowledge-table',
      expect.objectContaining({ filePath: 'src/auth/index.ts', churnRate30d: 5 })
    );
    // Author profile written
    expect(mocks.putItem).toHaveBeenCalledWith(
      'author-profiles-table',
      expect.objectContaining({ authorLogin: 'alice' })
    );
  });

  it('releases queued PRs when marking indexed', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mockOctokitInstance.rest.repos.get.mockResolvedValue({
      data: { default_branch: 'main' },
    });
    mocks.fetchFileTree.mockResolvedValue([]);
    mocks.detectModules.mockReturnValue([]);
    mocks.updateItem.mockResolvedValue(undefined);
    // First getItem call (releaseQueuedPRs → repo registry) returns queued IDs
    // Second getItem call (releaseQueuedPRs → execution lookup) returns execution
    mocks.getItem
      .mockResolvedValueOnce({
        repoFullName: 'org/repo',
        queuedExecutionIds: ['exec-1'],
      })
      .mockResolvedValueOnce({
        executionId: 'exec-1',
        prNumber: 5,
        repoFullName: 'org/repo',
        headSha: 'abc',
        baseSha: 'def',
        author: 'alice',
        title: 'Fix bug',
      });

    await handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }));

    // SQS should have been called to re-publish the queued execution
    expect(mocks.sqsSend).toHaveBeenCalled();
    // Should clear the queue
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      { queuedExecutionIds: [] }
    );
  });

  it('writes failed status with error message when full-index throws', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mockOctokitInstance.rest.repos.get.mockRejectedValue(new Error('GitHub API unavailable'));
    mocks.updateItem.mockResolvedValue(undefined);

    await expect(
      handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }))
    ).rejects.toThrow('GitHub API unavailable');

    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      expect.objectContaining({ indexingStatus: 'failed', lastError: 'GitHub API unavailable' })
    );
  });

  it('writes failed status with Unknown error for non-Error throws', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mockOctokitInstance.rest.repos.get.mockRejectedValue('string error');
    mocks.updateItem.mockResolvedValue(undefined);

    await expect(
      handler(makeEvent({ mode: 'full-index', repoFullName: 'org/repo', installationId: 1 }))
    ).rejects.toBe('string error');

    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      expect.objectContaining({ indexingStatus: 'failed', lastError: 'Unknown error' })
    );
  });
});

describe('handler — batch mode', () => {
  it('generates narratives, embeds, and upserts for each module', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();
    const generateNarrative = jest.requireMock('../narrative-generator')
      .generateModuleNarrative as jest.Mock;
    const generateEmbed = jest.requireMock('../embeddings').generateEmbedding as jest.Mock;
    const upsert = jest.requireMock('../opensearch-client').upsertNarrative as jest.Mock;

    mocks.atomicDecrement.mockResolvedValue(0);
    mocks.putItem.mockResolvedValue(undefined);
    mocks.updateItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('export function auth() {}').toString('base64') },
    });

    await handler(
      makeEvent({
        mode: 'batch',
        repoFullName: 'org/repo',
        modules: [
          {
            modulePath: 'src/auth',
            entryPoint: 'src/auth/index.ts',
            files: ['src/auth/index.ts'],
          },
        ],
        headSha: 'abc123',
      })
    );

    expect(generateNarrative).toHaveBeenCalled();
    expect(generateEmbed).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(mocks.putItem).toHaveBeenCalled();
    // atomicDecrement returned 0, so should mark indexed
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'registry-table',
      { repoFullName: 'org/repo' },
      expect.objectContaining({ indexingStatus: 'indexed' })
    );
  });
});

describe('handler — incremental mode', () => {
  it('updates file metrics and increments contextVersion', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/auth/index.ts',
      churnRate30d: 3,
      churnRate90d: 10,
      bugFixCommitCount30d: 1,
      authors: ['alice'],
      lastCommitSha: 'def456',
    });
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mocks.fetchFileTree.mockRejectedValue(new Error('skip'));
    mocks.detectModules.mockReturnValue([]);

    await handler(
      makeEvent({
        mode: 'incremental',
        repoFullName: 'org/repo',
        changedFiles: ['src/auth/index.ts'],
        author: 'alice',
        executionId: 'exec-123',
      })
    );

    // File metrics written
    expect(mocks.putItem).toHaveBeenCalledWith(
      'file-knowledge-table',
      expect.objectContaining({ filePath: 'src/auth/index.ts', churnRate30d: 3 })
    );
    // Author profile updated via partial UpdateCommand with atomic ADD (not putItem)
    const authorUpdateCall = mocks.docClientSend.mock.calls.find((call: unknown[]) => {
      const input = call[0] as { TableName?: string; UpdateExpression?: string };
      return (
        input.TableName === 'author-profiles-table' &&
        input.UpdateExpression?.includes('mergeCount30d')
      );
    });
    expect(authorUpdateCall).toBeDefined();
    // contextVersion incremented via direct docClient.send
    expect(mocks.docClientSend).toHaveBeenCalled();
  });

  it('regenerates narratives for affected modules', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();
    const generateNarrative = jest.requireMock('../narrative-generator')
      .generateModuleNarrative as jest.Mock;
    const generateEmbed = jest.requireMock('../embeddings').generateEmbedding as jest.Mock;
    const upsert = jest.requireMock('../opensearch-client').upsertNarrative as jest.Mock;

    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/auth/index.ts',
      churnRate30d: 1,
      churnRate90d: 2,
      bugFixCommitCount30d: 0,
      authors: ['alice'],
      lastCommitSha: 'abc',
    });
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    // fetchFileTree succeeds → detectModules finds affected module
    mocks.fetchFileTree.mockResolvedValue([
      'src/auth/index.ts',
      'src/auth/middleware.ts',
      'src/auth/utils.ts',
    ]);
    mocks.detectModules.mockReturnValue([
      {
        modulePath: 'src/auth',
        entryPoint: 'src/auth/index.ts',
        files: ['src/auth/index.ts', 'src/auth/middleware.ts', 'src/auth/utils.ts'],
      },
    ]);
    mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('export function auth() {}').toString('base64') },
    });

    await handler(
      makeEvent({
        mode: 'incremental',
        repoFullName: 'org/repo',
        changedFiles: ['src/auth/index.ts'],
        author: 'alice',
      })
    );

    expect(generateNarrative).toHaveBeenCalled();
    expect(generateEmbed).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(mocks.putItem).toHaveBeenCalledWith(
      'module-narratives-table',
      expect.objectContaining({ modulePath: 'src/auth' })
    );
  });

  it('handles pr.merged EventBridge envelope, fetches changed files from GitHub, and routes to incremental handler', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    // Mock GitHub API to return changed files for the PR
    mockOctokitInstance.rest.pulls = {
      listFiles: jest.fn().mockResolvedValue({
        data: [{ filename: 'src/index.ts' }, { filename: 'src/utils.ts' }],
      }),
    } as never;

    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/index.ts',
      churnRate30d: 2,
      churnRate90d: 5,
      bugFixCommitCount30d: 0,
      authors: ['octocat'],
      lastCommitSha: 'sha789',
    });
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mocks.fetchFileTree.mockRejectedValue(new Error('skip'));
    mocks.detectModules.mockReturnValue([]);

    // Actual PRMergedEvent shape — no changedFiles field
    const sqsEvent = makeEvent({
      'detail-type': 'pr.merged',
      detail: {
        repoFullName: 'org/repo',
        prNumber: 42,
        headSha: 'abc123',
        author: 'octocat',
        mergedAt: Date.now(),
        executionId: 'exec-123',
      },
    });

    await handler(sqsEvent);

    // Verify GitHub API was called to fetch changed files
    expect(mockOctokitInstance.rest.pulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'org', repo: 'repo', pull_number: 42 })
    );
    // Verify incremental processing was attempted (file metrics update)
    expect(mocks.putItem).toHaveBeenCalledWith(
      'file-knowledge-table',
      expect.objectContaining({ filePath: 'src/index.ts' })
    );
    // Author profile updated via partial UpdateCommand with atomic ADD (not putItem)
    const authorUpdateCall = mocks.docClientSend.mock.calls.find((call: unknown[]) => {
      const input = call[0] as { TableName?: string; UpdateExpression?: string };
      return (
        input.TableName === 'author-profiles-table' &&
        input.UpdateExpression?.includes('mergeCount30d')
      );
    });
    expect(authorUpdateCall).toBeDefined();
    // contextVersion incremented
    expect(mocks.docClientSend).toHaveBeenCalled();
  });

  it('handles pr.merged envelope gracefully when GitHub file fetch fails', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockOctokitInstance.rest.pulls = {
      listFiles: jest.fn().mockRejectedValue(new Error('API rate limited')),
    } as never;

    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mocks.fetchFileTree.mockRejectedValue(new Error('skip'));
    mocks.detectModules.mockReturnValue([]);

    const sqsEvent = makeEvent({
      'detail-type': 'pr.merged',
      detail: {
        repoFullName: 'org/repo',
        prNumber: 42,
        headSha: 'abc123',
        author: 'octocat',
        mergedAt: Date.now(),
      },
    });

    await handler(sqsEvent);

    // Should warn about fetch failure
    expect(warnSpy).toHaveBeenCalledWith(
      '[repo-indexer] Failed to fetch PR changed files',
      expect.objectContaining({ repoFullName: 'org/repo', prNumber: 42 })
    );
    // Should still process author profile via partial UpdateCommand (graceful degradation)
    const authorUpdateCall = mocks.docClientSend.mock.calls.find((call: unknown[]) => {
      const input = call[0] as { TableName?: string; UpdateExpression?: string };
      return (
        input.TableName === 'author-profiles-table' &&
        input.UpdateExpression?.includes('mergeCount30d')
      );
    });
    expect(authorUpdateCall).toBeDefined();
    warnSpy.mockRestore();
  });

  it('logs warning for unrecognized message format', async () => {
    const handler = await loadHandler();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await handler(makeEvent({ unknownField: 'something' }));

    expect(warnSpy).toHaveBeenCalledWith(
      '[repo-indexer] Unrecognized message format',
      expect.any(Object)
    );
    warnSpy.mockRestore();
  });

  it('should increment mergeCount without overwriting rollbackRate and avgRiskScore', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/auth/index.ts',
      churnRate30d: 3,
      churnRate90d: 10,
      bugFixCommitCount30d: 1,
      authors: ['octocat'],
      lastCommitSha: 'def456',
    });
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mocks.fetchFileTree.mockRejectedValue(new Error('skip'));
    mocks.detectModules.mockReturnValue([]);

    await handler(
      makeEvent({
        mode: 'incremental',
        repoFullName: 'org/repo',
        changedFiles: ['src/auth/index.ts'],
        author: 'octocat',
        executionId: 'exec-123',
      })
    );

    // Should NOT use putItem for author profiles (it overwrites rollbackRate/avgRiskScore)
    const authorPutCalls = mocks.putItem.mock.calls.filter(
      (call: unknown[]) => call[0] === 'author-profiles-table'
    );
    expect(authorPutCalls).toHaveLength(0);

    // Should NOT read author profile via getItem (atomic ADD eliminates read-before-write)
    const authorGetCalls = mocks.getItem.mock.calls.filter(
      (call: unknown[]) => call[0] === 'author-profiles-table'
    );
    expect(authorGetCalls).toHaveLength(0);

    // Should use UpdateCommand (partial update) via docClient.send
    const authorUpdateCall = mocks.docClientSend.mock.calls.find((call: unknown[]) => {
      const input = call[0] as { TableName?: string; UpdateExpression?: string };
      return (
        input.TableName === 'author-profiles-table' &&
        input.UpdateExpression?.includes('mergeCount30d')
      );
    });
    expect(authorUpdateCall).toBeDefined();
    // Verify it uses ADD for atomic increment and sets the correct author
    const updateInput = authorUpdateCall![0] as {
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(updateInput.UpdateExpression).toContain('ADD mergeCount30d');
    expect(updateInput.ExpressionAttributeValues[':author']).toBe('octocat');
  });

  it('skips author update when author is not provided', async () => {
    const handler = await loadHandler();
    const mocks = getMocks();

    mocks.fetchFileCommitHistory.mockResolvedValue({
      filePath: 'src/file.ts',
      churnRate30d: 1,
      churnRate90d: 2,
      bugFixCommitCount30d: 0,
      authors: [],
      lastCommitSha: 'abc',
    });
    mocks.putItem.mockResolvedValue(undefined);
    mocks.getItem.mockResolvedValue(null);
    mocks.fetchFileTree.mockRejectedValue(new Error('skip'));
    mocks.detectModules.mockReturnValue([]);

    await handler(
      makeEvent({
        mode: 'incremental',
        repoFullName: 'org/repo',
        changedFiles: ['src/file.ts'],
      })
    );

    // Should only write file metrics, not author profile
    expect(mocks.putItem).toHaveBeenCalledTimes(1);
    expect(mocks.putItem).toHaveBeenCalledWith(
      'file-knowledge-table',
      expect.objectContaining({ filePath: 'src/file.ts' })
    );
  });
});
