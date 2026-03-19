import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { assembleContext } from '../context-assembly';

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);

const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockOctokit = {
  rest: { pulls: { get: jest.fn() } },
};

beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  jest.resetAllMocks();
  global.fetch = mockFetch;
});

describe('assembleContext', () => {
  const baseConfig = {
    repoRegistryTable: 'registry-table',
    fileKnowledgeTable: 'file-table',
    authorProfilesTable: 'author-table',
    moduleNarrativesTable: 'narratives-table',
    opensearchEndpoint: 'https://os.example.com',
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
    // DynamoDB: contextVersion
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 3 } });

    // DynamoDB: file metrics
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { 'file-table': [{ pk: 'org/repo#src/auth.ts', churnRate30d: 5 }] } });

    // DynamoDB: author profile
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

    // Bedrock: embedding
    const embeddingResponse = JSON.stringify({ embedding: new Array(1536).fill(0.1) });
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(embeddingResponse) as never,
    });

    // OpenSearch returns narratives
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  modulePath: 'src/auth',
                  narrativeText: 'Auth module.',
                  repoFullName: 'org/repo',
                  generatedAtSha: 'abc',
                  version: 1,
                },
              },
            ],
          },
        }),
    });

    // PR description
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: 'Fixes the login bug.' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.contextQuality).toBe('full');
    expect(result.prDescription).toBe('Fixes the login bug.');
    expect(result.moduleNarratives).toHaveLength(1);
    expect(result.contextVersion).toBe(3);
  });

  it('returns partial contextQuality when OpenSearch times out', async () => {
    // DynamoDB: contextVersion
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });

    // DynamoDB: file metrics — empty
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });

    // DynamoDB: author profile — none
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });

    // DynamoDB: module narratives fallback — return a narrative
    ddbMock.on(GetCommand, { TableName: 'narratives-table' }).resolves({
      Item: {
        modulePath: 'src',
        narrativeText: 'Fallback narrative.',
        repoFullName: 'org/repo',
        generatedAtSha: 'abc',
        version: 1,
      },
    });

    // Bedrock timeout simulated by rejection
    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));

    // OpenSearch — not reached because embedding fails first
    mockFetch.mockRejectedValue(new Error('timeout'));

    // PR description
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // All DynamoDB calls fail
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));
    ddbMock.on(BatchGetCommand).rejects(new Error('DynamoDB error'));

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockFetch.mockRejectedValue(new Error('timeout'));

    // PR description fails too
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error('GitHub error'));

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockFetch.mockRejectedValue(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOctokit as any,
      basePrEvent,
      [],
      'mock diff content',
      baseConfig
    );

    expect(result.fileMetrics).toEqual([]);
    // No BatchGetCommand should have been sent for empty files
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('defaults contextVersion to 1 when registry record has no version', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo' } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockFetch.mockRejectedValue(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockFetch.mockRejectedValue(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: null } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    expect(result.prDescription).toBe('');
  });

  it('falls back to DynamoDB narratives when OpenSearch returns non-ok status', async () => {
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

    // Bedrock succeeds for embedding
    const embeddingResponse = JSON.stringify({ embedding: new Array(1536).fill(0.1) });
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(embeddingResponse) as never,
    });

    // OpenSearch returns 500
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Bedrock never resolves — simulates a hang
    bedrockMock.on(InvokeModelCommand).callsFake(() => new Promise(() => {}));

    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const resultPromise = assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOctokit as any,
      basePrEvent,
      ['src/auth.ts'],
      'mock diff content',
      baseConfig
    );

    // Advance past the timeout
    jest.advanceTimersByTime(4000);

    const result = await resultPromise;

    // Should fall back gracefully — 'none' because no context data was available
    expect(result.contextQuality).toBe('none');

    jest.useRealTimers();
  });

  it('skips root-level files when computing module path prefixes for fallback', async () => {
    ddbMock
      .on(GetCommand, { TableName: 'registry-table' })
      .resolves({ Item: { repoFullName: 'org/repo', contextVersion: 1 } });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'file-table': [] } });
    ddbMock.on(GetCommand, { TableName: 'author-table' }).resolves({ Item: undefined });

    bedrockMock.on(InvokeModelCommand).rejects(new Error('timeout'));
    mockFetch.mockRejectedValue(new Error('timeout'));
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: '' } });

    const result = await assembleContext(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockOctokit as any,
      basePrEvent,
      ['README.md'], // root-level file, no directory prefix
      'mock diff content',
      baseConfig
    );

    // Root-level files produce empty prefix which is skipped — no narratives table lookup
    expect(result.moduleNarratives).toEqual([]);
  });
});
