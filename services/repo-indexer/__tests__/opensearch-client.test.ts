import { upsertNarrative, queryNarratives } from '../opensearch-client';

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => jest.resetAllMocks());

describe('upsertNarrative', () => {
  it('sends a PUT request to the OpenSearch endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    await upsertNarrative(
      'https://os.example.com',
      {
        repoFullName: 'org/repo',
        modulePath: 'src/auth',
        narrativeText: 'Auth module',
        generatedAtSha: 'abc',
        version: 1,
      },
      [0.1, 0.2]
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('src%2Fauth'),
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('throws on non-OK upsert response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      upsertNarrative(
        'https://os.example.com',
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
  it('returns top-k narrative results from OpenSearch k-NN query', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  modulePath: 'src/auth',
                  narrativeText: 'Auth module',
                  repoFullName: 'org/repo',
                  generatedAtSha: 'abc',
                  version: 1,
                },
              },
            ],
          },
        }),
    });
    const results = await queryNarratives('https://os.example.com', 'org/repo', [0.1, 0.2], 5);
    expect(results).toHaveLength(1);
    expect(results[0].modulePath).toBe('src/auth');
  });

  it('throws on non-OK query response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(queryNarratives('https://os.example.com', 'org/repo', [0.1], 5)).rejects.toThrow(
      'OpenSearch query failed: 503'
    );
  });
});
