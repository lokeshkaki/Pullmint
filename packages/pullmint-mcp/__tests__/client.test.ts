import { PullmintClient } from '../src/client';
import { PullmintApiError } from '../src/errors';

const config = {
  apiUrl: 'http://localhost:3000',
  authToken: 'private-token',
  requestTimeoutMs: 1000,
};

describe('PullmintClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends bearer authentication to list PR executions', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ executions: [], count: 0 }), { status: 200 })
      );
    const client = new PullmintClient(config);

    await client.listPrAnalyses({ owner: 'org', repo: 'repo', prNumber: 42, limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/repos/org/repo/prs/42?limit=10',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer private-token' }),
      })
    );
  });

  it('maps auth errors without echoing response secrets', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'token=private-token' }), { status: 401 })
      );
    const client = new PullmintClient(config);

    await expect(client.getAnalysis({ executionId: 'exec-1' })).rejects.toEqual(
      expect.objectContaining({ code: 'authentication_failed', status: 401 })
    );
    await client.getAnalysis({ executionId: 'exec-1' }).catch((error: PullmintApiError) => {
      expect(error.message).not.toContain('private-token');
    });
  });

  it.each([
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'operation_failed'],
  ])('maps HTTP %i to %s without returning server content', async (status, code) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'internal-secret' }), { status }));
    const client = new PullmintClient(config);

    await expect(client.getAnalysis({ executionId: 'exec-1' })).rejects.toEqual(
      expect.objectContaining({ code, status })
    );
  });

  it('maps an aborted or unavailable request to api_unavailable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('AbortError'));
    const client = new PullmintClient(config);

    await expect(client.getAnalysis({ executionId: 'exec-1' })).rejects.toEqual(
      expect.objectContaining({ code: 'api_unavailable' })
    );
  });

  it('strips unrelated fields from stored analysis output', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          status: 'completed',
          headSha: 'head',
          findings: [],
          s3Key: 'internal-object-key',
        }),
        { status: 200 }
      )
    );
    const client = new PullmintClient(config);

    await expect(client.getAnalysis({ executionId: 'exec-1' })).resolves.not.toHaveProperty(
      's3Key'
    );
  });

  it('posts the explicit manual trigger body and returns accepted execution data', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Analysis queued',
          executionId: 'manual-1',
          repoFullName: 'org/repo',
          prNumber: 42,
          headSha: 'head',
          status: 'pending',
          costIncurred: true,
        }),
        { status: 202 }
      )
    );
    const client = new PullmintClient(config);

    await expect(
      client.triggerAnalysis({ owner: 'org', repo: 'repo', prNumber: 42, reason: 'Fixed finding' })
    ).resolves.toEqual(expect.objectContaining({ executionId: 'manual-1', costIncurred: true }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/dashboard/repos/org/repo/prs/42/analyze',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Fixed finding' }),
      })
    );
  });
});
