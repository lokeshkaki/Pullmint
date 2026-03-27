import Fastify from 'fastify';
import { registerDashboardRoutes } from '../src/routes/dashboard';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {
      executionId: 'executionId',
      repoFullName: 'repoFullName',
      prNumber: 'prNumber',
      author: 'author',
      title: 'title',
      orgId: 'orgId',
      status: 'status',
      riskScore: 'riskScore',
      findings: 'findings',
      createdAt: 'createdAt',
      headSha: 'headSha',
      baseSha: 'baseSha',
      metadata: 'metadata',
      deploymentStartedAt: 'deploymentStartedAt',
    },
    webhookDedup: { deliveryId: 'deliveryId', expiresAt: 'expiresAt' },
    calibrations: { repoFullName: 'repoFullName', calibrationFactor: 'calibrationFactor' },
    repoRegistry: {
      repoFullName: 'repoFullName',
      indexingStatus: 'indexingStatus',
      pendingBatches: 'pendingBatches',
    },
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    ANALYSIS: 'analysis',
    REPO_INDEXING: 'repo-indexing',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'DASHBOARD_AUTH_TOKEN') return 'test-token';
    return 'test-value';
  }),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));

const VALID_AUTH = 'Bearer test-token';

const terminalExecution = {
  executionId: 'exec-original-1',
  repoFullName: 'org/repo',
  prNumber: 42,
  headSha: 'abc1234',
  baseSha: 'def5678',
  author: 'dev',
  title: 'Test PR',
  orgId: 'org_1',
  status: 'completed',
  riskScore: 65,
  findings: [],
  metadata: null,
  createdAt: new Date('2026-03-26T10:00:00.000Z'),
  updatedAt: new Date('2026-03-26T10:00:00.000Z'),
};

const activeExecution = { ...terminalExecution, executionId: 'exec-active-1', status: 'analyzing' };

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );
  registerDashboardRoutes(app);
  return app;
}

function buildLimitMock(rows: unknown[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('Re-run Endpoints', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /dashboard/executions/:executionId/rerun', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/dashboard/executions/exec-1/rerun' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when execution not found', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue(buildLimitMock([]));

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/nonexistent/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when execution is not in terminal state', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue(buildLimitMock([activeExecution]));

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-active-1/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string; currentStatus: string };
      expect(body.currentStatus).toBe('analyzing');
    });

    it('returns 429 when called within rate limit window', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      let callCount = 0;

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                callCount++;
                return Promise.resolve(
                  callCount === 1 ? [terminalExecution] : [{ deliveryId: 'rerun:exec-original-1' }]
                );
              }),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-original-1/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(429);
    });

    it('creates new execution and enqueues analysis job, returns 202', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };

      let callCount = 0;
      const insertValues = jest.fn().mockResolvedValue(undefined);
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                callCount++;
                return Promise.resolve(callCount === 1 ? [terminalExecution] : []);
              }),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-original-1/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body) as { executionId: string; status: string };
      expect(body.status).toBe('pending');
      expect(body.executionId).toMatch(/^exec-/);

      expect(addJob).toHaveBeenCalledWith(
        'analysis',
        'pr.opened',
        expect.objectContaining({
          prNumber: 42,
          repoFullName: 'org/repo',
          headSha: 'abc1234',
        })
      );

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ rerunOf: 'exec-original-1' }),
          status: 'pending',
        })
      );
    });

    it('also accepts failed status as terminal', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      const failedExecution = { ...terminalExecution, status: 'failed' };
      let callCount = 0;

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                callCount++;
                return Promise.resolve(callCount === 1 ? [failedExecution] : []);
              }),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-original-1/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(202);
    });
  });

  describe('POST /dashboard/repos/:owner/:repo/prs/:number/rerun', () => {
    it('returns 400 for non-numeric PR number', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/repo/prs/not-a-number/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no prior execution exists', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/repo/prs/42/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 502 when GitHub API call fails', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      const { getGitHubInstallationClient } = jest.requireMock('@pullmint/shared/github-app') as {
        getGitHubInstallationClient: jest.Mock;
      };

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([terminalExecution]),
              }),
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      });

      getGitHubInstallationClient.mockResolvedValue({
        rest: {
          pulls: {
            get: jest.fn().mockRejectedValue(new Error('GitHub API error')),
          },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/repo/prs/42/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(502);
    });

    it('creates new execution with current HEAD and returns 202', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      const { addJob } = jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock };
      const { getGitHubInstallationClient } = jest.requireMock('@pullmint/shared/github-app') as {
        getGitHubInstallationClient: jest.Mock;
      };

      const insertValues = jest.fn().mockResolvedValue(undefined);

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([terminalExecution]),
              }),
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      });

      getGitHubInstallationClient.mockResolvedValue({
        rest: {
          pulls: {
            get: jest.fn().mockResolvedValue({
              data: {
                head: { sha: 'newheadsha123' },
                base: { sha: 'newbasesha456' },
                user: { login: 'dev' },
                title: 'Test PR',
              },
            }),
          },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/repo/prs/42/rerun',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body) as { executionId: string; status: string; headSha: string };
      expect(body.headSha).toBe('newheadsha123');
      expect(body.status).toBe('pending');

      expect(addJob).toHaveBeenCalledWith(
        'analysis',
        'pr.opened',
        expect.objectContaining({
          headSha: 'newheadsha123',
          baseSha: 'newbasesha456',
          repoFullName: 'org/repo',
          prNumber: 42,
        })
      );

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          headSha: 'newheadsha123',
          metadata: expect.objectContaining({
            rerunOf: 'exec-original-1',
            rerunType: 'latest-head',
          }),
        })
      );
    });
  });

  describe('GET /dashboard/executions/:executionId/rerun-history', () => {
    it('returns 404 when execution not found', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue(buildLimitMock([]));

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/nonexistent/rerun-history',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns chain with single entry for execution with no reruns', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      let callCount = 0;

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                callCount++;
                return Promise.resolve(callCount === 1 ? [terminalExecution] : []);
              }),
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/exec-original-1/rerun-history',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        chain: Array<{ executionId: string }>;
        rootExecutionId: string;
      };
      expect(body.rootExecutionId).toBe('exec-original-1');
      expect(body.chain).toEqual([
        expect.objectContaining({
          executionId: 'exec-original-1',
          riskScoreDelta: null,
        }),
      ]);
    });

    it('computes riskScoreDelta correctly in chain', async () => {
      const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
      const child = {
        ...terminalExecution,
        executionId: 'exec-child',
        createdAt: new Date('2026-03-26T11:00:00.000Z'),
        riskScore: 45,
        metadata: { rerunOf: 'exec-original-1' },
      };

      let limitCallCount = 0;
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockImplementation(() => {
                limitCallCount++;
                return Promise.resolve(limitCallCount === 1 ? [terminalExecution] : []);
              }),
              orderBy: jest.fn().mockResolvedValue([child]),
            }),
          }),
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/exec-original-1/rerun-history',
        headers: { authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        chain: Array<{ executionId: string; riskScoreDelta: number | null }>;
      };

      expect(body.chain).toEqual([
        expect.objectContaining({ executionId: 'exec-original-1', riskScoreDelta: null }),
        expect.objectContaining({ executionId: 'exec-child', riskScoreDelta: -20 }),
      ]);
    });
  });
});
