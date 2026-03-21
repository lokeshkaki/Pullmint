import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { assembleContext } from '../context-assembly';

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

const mockOctokit = {
  rest: { pulls: { get: jest.fn() } },
};

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  jest.resetAllMocks();
});

describe('assembleContext', () => {
  const baseConfig = {
    repoRegistryTable: 'registry-table',
    fileKnowledgeTable: 'file-table',
    authorProfilesTable: 'author-table',
    moduleNarrativesTable: 'narratives-table',
  };

  const basePrEvent = {
    repoFullName: 'org/repo',
    prNumber: 1,
    headSha: 'abc',
    baseSha: 'def',
    author: 'alice',
    title: 'Fix auth',
    orgId: 'org_1',
    executionId: 'exec-1',
  };

  it('returns full contextQuality when all sources respond', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 3 } });

    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { 'file-table': [{ pk: 'org/repo#src/auth.ts', churnRate30d: 5 }] } });

    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({
      Item: {
        repoFullName: 'org/repo',
        authorLogin: 'alice',
        rollbackRate: 0,
        mergeCount30d: 5,
        avgRiskScore: 20,
        frequentFiles: ['src/auth.ts'],
      },
    });

    ddbMock
      .on(QueryCommand, { TableName: 'narratives-table', IndexName: 'repoFullName-index' })
      .resolves({
        Items: [
          {
            modulePath: 'src/auth',
            narrativeText: 'Auth module.',
            repoFullName: 'org/repo',
            generatedAtSha: 'abc',
            version: 1,
            embedding: [1, 0, 0],
          },
          {
            modulePath: 'src/utils',
            narrativeText: 'Utility module.',
            repoFullName: 'org/repo',
            generatedAtSha: 'abc',
            version: 1,
            embedding: [0, 1, 0],
          },
        ],
      });

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [0.9, 0.1, 0] })) as never,
    });

    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: 'Fixes the login bug.' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('full');
    expect(result.prDescription).toBe('Fixes the login bug.');
    expect(result.moduleNarratives[0].modulePath).toBe('src/auth');
    expect(result.contextVersion).toBe(3);
  });

  it('returns partial contextQuality when embedding generation fails and prefix fallback succeeds', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({
      Item: {
        modulePath: 'src',
        narrativeText: 'Fallback narrative.',
        repoFullName: 'org/repo',
        generatedAtSha: 'abc',
        version: 1,
      },
    });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('partial');
    expect(result.moduleNarratives).toHaveLength(1);
    expect(result.moduleNarratives[0].narrativeText).toBe('Fallback narrative.');
  });

  it('returns none contextQuality when all context sources fail', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));
    ddbMock.on(BatchGetCommand).rejects(new Error('DynamoDB error'));
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error('GitHub error'));

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('none');
    expect(result.fileMetrics).toEqual([]);
    expect(result.authorProfile).toBeNull();
    expect(result.moduleNarratives).toEqual([]);
  });

  it('returns empty file metrics when changedFiles is empty', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [1, 0, 0] })) as never,
    });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      [],
      'mock diff content',
      baseConfig
    );

    expect(result.fileMetrics).toEqual([]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('caps file metrics to 100 files and warns when PR touches more', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const manyFiles = Array.from({ length: 105 }, (_, index) => `src/file${index}.ts`);

    await assembleContext(
      mockOctokit as any,
      basePrEvent,
      manyFiles,
      'mock diff content',
      baseConfig
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('105 files'));

    const batchCalls = ddbMock.commandCalls(BatchGetCommand);
    expect(batchCalls).toHaveLength(1);
    const keys = batchCalls[0].args[0].input.RequestItems?.['file-table']?.Keys;
    expect(keys).toHaveLength(100);

    warnSpy.mockRestore();
  });

  it('defaults contextVersion to 1 when registry record has no version', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo' } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextVersion).toBe(1);
  });

  it('handles null PR description body', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [1, 0, 0] })) as never,
    });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: null } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.prDescription).toBe('');
  });

  it('should fetch narratives from DynamoDB using repoFullName GSI and rank by similarity', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: 'org/repo#src/auth',
          repoFullName: 'org/repo',
          modulePath: 'src/auth',
          narrativeText: 'Authentication module',
          generatedAtSha: 'abc',
          version: 1,
          embedding: [1, 0, 0],
        },
        {
          pk: 'org/repo#src/utils',
          repoFullName: 'org/repo',
          modulePath: 'src/utils',
          narrativeText: 'Utility functions',
          generatedAtSha: 'def',
          version: 1,
          embedding: [0, 1, 0],
        },
      ],
    });

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [0.9, 0.1, 0] })) as never,
    });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth/index.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.moduleNarratives.length).toBeGreaterThan(0);
    expect(result.moduleNarratives[0].modulePath).toBe('src/auth');
  });

  it('falls back to prefix search when repo narratives are missing embeddings', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: 'org/repo#src/auth',
          repoFullName: 'org/repo',
          modulePath: 'src/auth',
          narrativeText: 'Auth module without embedding.',
          generatedAtSha: 'abc',
          version: 1,
        },
      ],
    });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({
      Item: {
        modulePath: 'src',
        narrativeText: 'Prefix fallback narrative.',
        repoFullName: 'org/repo',
        generatedAtSha: 'abc',
        version: 1,
      },
    });

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [1, 0, 0] })) as never,
    });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth/file.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('partial');
    expect(result.moduleNarratives).toHaveLength(1);
    expect(result.moduleNarratives[0].narrativeText).toBe('Prefix fallback narrative.');
    expect(warnSpy).toHaveBeenCalledWith(
      '[context-assembly] Repo narratives missing embeddings, falling back to prefix search',
      expect.objectContaining({ repoFullName: 'org/repo', narrativeCount: 1 })
    );

    warnSpy.mockRestore();
  });

  it('falls back to prefix search when the repo narrative query fails', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 2 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({
      Item: {
        modulePath: 'src',
        narrativeText: 'DynamoDB fallback.',
        repoFullName: 'org/repo',
        generatedAtSha: 'abc',
        version: 1,
      },
    });
    ddbMock.on(QueryCommand).rejects(new Error('query failed'));

    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(JSON.stringify({ embedding: [1, 0, 0] })) as never,
    });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('partial');
    expect(result.moduleNarratives).toHaveLength(1);
    expect(result.moduleNarratives[0].narrativeText).toBe('DynamoDB fallback.');
  });

  it('triggers timeout when embedding takes too long', async () => {
    jest.useFakeTimers();

    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).callsFake(() => new Promise(() => {}));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const resultPromise = assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    jest.advanceTimersByTime(4000);

    const result = await resultPromise;

    expect(result.contextQuality).toBe('none');

    jest.useRealTimers();
  });

  it('times out DynamoDB fallback loop when timeout budget is exceeded', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const nowSpy = jest.spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 3000;
      return now;
    });

    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({
      Item: {
        modulePath: 'src/a',
        narrativeText: 'Fallback narrative.',
        repoFullName: 'org/repo',
        generatedAtSha: 'abc',
        version: 1,
      },
    });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('embedding failed'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['src/a/file.ts', 'src/b/file.ts', 'src/c/file.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('partial');
    expect(result.moduleNarratives).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[context-assembly] Embedding generation failed, falling back to prefix search',
      expect.objectContaining({ error: 'embedding failed' })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[context-assembly] DynamoDB fallback loop timed out',
      expect.objectContaining({ fetchedCount: 1, remainingPrefixes: 2 })
    );

    nowSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('skips root-level files when computing module path prefixes for fallback', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      mockOctokit as any,
      basePrEvent,
      ['README.md'],
      'mock diff content',
      baseConfig
    );

    expect(result.moduleNarratives).toEqual([]);
    expect(
      ddbMock
        .commandCalls(GetCommand)
        .filter((call) => call.args[0].input.TableName === 'narratives-table')
    ).toHaveLength(0);
  });
});
