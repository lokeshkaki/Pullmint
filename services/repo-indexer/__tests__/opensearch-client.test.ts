const mockIndex = jest.fn();
const mockSearch = jest.fn();

jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    index: mockIndex,
    search: mockSearch,
  })),
}));
jest.mock('@opensearch-project/opensearch/aws', () => ({
  AwsSigv4Signer: jest.fn().mockReturnValue({ node: 'https://mock-endpoint' }),
}));
jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: jest
    .fn()
    .mockReturnValue(() => Promise.resolve({ accessKeyId: 'test', secretAccessKey: 'test' })),
}));

import { upsertNarrative, queryNarratives } from '../opensearch-client';

beforeEach(() => {
  jest.clearAllMocks();
  mockIndex.mockResolvedValue({ statusCode: 200, body: { result: 'created' } });
  mockSearch.mockResolvedValue({
    statusCode: 200,
    body: {
      hits: {
        hits: [
          {
            _source: {
              repoFullName: 'org/repo',
              modulePath: 'src/auth',
              narrativeText: 'Auth module handles login',
              generatedAtSha: 'abc123',
              version: 1,
            },
          },
        ],
      },
    },
  });
});

describe('upsertNarrative', () => {
  it('should call index with correct document ID and body', async () => {
    const narrative = {
      repoFullName: 'org/repo',
      modulePath: 'src/auth',
      narrativeText: 'Auth module handles login',
      generatedAtSha: 'abc123',
      version: 1,
    };
    const embedding = [0.1, 0.2, 0.3];

    await upsertNarrative('https://mock-endpoint', narrative, embedding);

    expect(mockIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'module-narrative-index',
        id: encodeURIComponent('org/repo/src/auth'),
        body: expect.objectContaining({ repoFullName: 'org/repo', embedding }),
        refresh: false,
      })
    );
  });

  it('throws when OpenSearch rejects the upsert request', async () => {
    mockIndex.mockRejectedValueOnce({ statusCode: 500, message: 'internal error' });

    await expect(
      upsertNarrative(
        'https://mock-endpoint',
        {
          repoFullName: 'org/repo',
          modulePath: 'x',
          narrativeText: '',
          generatedAtSha: '',
          version: 1,
        },
        []
      )
    ).rejects.toThrow('OpenSearch upsert failed: 500');
  });
});

describe('queryNarratives', () => {
  it('should call search with knn query filtered by repo', async () => {
    const results = await queryNarratives('https://mock-endpoint', 'org/repo', [0.1, 0.2], 5);

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'module-narrative-index',
        body: {
          size: 5,
          query: {
            knn: {
              embedding: {
                vector: [0.1, 0.2],
                k: 5,
                filter: { term: { repoFullName: 'org/repo' } },
              },
            },
          },
        },
      })
    );

    expect(results).toHaveLength(1);
    expect(results[0].repoFullName).toBe('org/repo');
    expect(results[0].modulePath).toBe('src/auth');
  });

  it('throws when OpenSearch rejects the query request', async () => {
    mockSearch.mockRejectedValueOnce({ statusCode: 503, message: 'service unavailable' });

    await expect(queryNarratives('https://mock-endpoint', 'org/repo', [0.1], 5)).rejects.toThrow(
      'OpenSearch query failed: 503'
    );
  });
});
