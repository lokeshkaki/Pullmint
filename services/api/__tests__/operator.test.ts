import Fastify from 'fastify';
import { registerDashboardAuth } from '../src/routes/dashboard-auth';
import { registerOperatorRoutes } from '../src/routes/operator';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: { executionId: 'executionId', status: 'status' },
    webhookDedup: { deliveryId: 'deliveryId' },
  },
}));
jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => (key === 'DASHBOARD_AUTH_TOKEN' ? 'test-token' : 'value')),
}));
jest.mock('@pullmint/shared/github-app', () => ({
  getGitHubInstallationClient: jest.fn(),
}));
jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: { ANALYSIS: 'analysis' },
}));
jest.mock('@pullmint/shared/tracing', () => ({ addTraceAnnotations: jest.fn() }));
jest.mock('@pullmint/shared/execution-events', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('crypto', () => ({
  ...jest.requireActual<typeof import('crypto')>('crypto'),
  randomUUID: jest.fn().mockReturnValue('manual-uuid'),
}));

const VALID_AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const pullRequest = {
  number: 42,
  state: 'open',
  title: 'Fix authentication',
  head: { sha: 'head123' },
  base: { sha: 'base123', repo: { owner: { id: 9 } } },
  user: { login: 'alice' },
};
let executionInsertValues: unknown;

function buildDb() {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        if ('executionId' in values) executionInsertValues = values;
        return Promise.resolve(undefined);
      }),
    }),
    update: jest.fn(),
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  registerDashboardAuth(app);
  registerOperatorRoutes(app);
  return app;
}

describe('Operator Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    executionInsertValues = undefined;
    const db = buildDb();
    (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb.mockReturnValue(db);
    (
      jest.requireMock('@pullmint/shared/github-app') as {
        getGitHubInstallationClient: jest.Mock;
      }
    ).getGitHubInstallationClient.mockResolvedValue({
      rest: { pulls: { get: jest.fn().mockResolvedValue({ data: pullRequest }) } },
    });
  });

  it('does no GitHub or queue work when authentication is missing', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(
      (
        jest.requireMock('@pullmint/shared/github-app') as {
          getGitHubInstallationClient: jest.Mock;
        }
      ).getGitHubInstallationClient
    ).not.toHaveBeenCalled();
    expect(
      (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb
    ).not.toHaveBeenCalled();
    expect(
      (jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock }).addJob
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects invalid PR parameters and an oversized reason', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/0/analyze',
      headers: VALID_AUTH,
      payload: { reason: 'x'.repeat(501) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('creates and enqueues a manual analysis for the current open PR', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: { reason: 'Verify the fix' },
    });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        message: 'Analysis queued',
        executionId: 'org/repo#42#head123-manual-manual-uuid',
        headSha: 'head123',
        status: 'pending',
        costIncurred: true,
      })
    );
    const { addJob, QUEUE_NAMES } = jest.requireMock('@pullmint/shared/queue') as {
      addJob: jest.Mock;
      QUEUE_NAMES: { ANALYSIS: string };
    };
    expect(addJob).toHaveBeenCalledWith(
      QUEUE_NAMES.ANALYSIS,
      'pr.manual',
      expect.objectContaining({ executionId: 'org/repo#42#head123-manual-manual-uuid' })
    );
    expect(
      (jest.requireMock('@pullmint/shared/tracing') as { addTraceAnnotations: jest.Mock })
        .addTraceAnnotations
    ).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'org/repo#42#head123-manual-manual-uuid' })
    );
    expect(executionInsertValues).toEqual(
      expect.objectContaining({
        status: 'pending',
        metadata: { trigger: 'manual', source: 'operator-api', reason: 'Verify the fix' },
      })
    );
    await app.close();
  });

  it('rejects a closed PR before database or queue writes', async () => {
    const { getGitHubInstallationClient } = jest.requireMock('@pullmint/shared/github-app') as {
      getGitHubInstallationClient: jest.Mock;
    };
    getGitHubInstallationClient.mockResolvedValueOnce({
      rest: {
        pulls: { get: jest.fn().mockResolvedValue({ data: { ...pullRequest, state: 'closed' } }) },
      },
    });
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(
      (jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock }).getDb
    ).not.toHaveBeenCalled();
    expect(
      (jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock }).addJob
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 429 without queueing a duplicate manual run for the same head SHA', async () => {
    const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
    const db = buildDb();
    db.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest
          .fn()
          .mockReturnValue({ limit: jest.fn().mockResolvedValue([{ deliveryId: 'existing' }]) }),
      }),
    });
    getDb.mockReturnValueOnce(db);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(429);
    expect(
      (jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock }).addJob
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns an operator-safe error when GitHub cannot access the PR', async () => {
    const { getGitHubInstallationClient } = jest.requireMock('@pullmint/shared/github-app') as {
      getGitHubInstallationClient: jest.Mock;
    };
    getGitHubInstallationClient.mockRejectedValueOnce(new Error('credential detail'));
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('credential detail');
    await app.close();
  });

  it('does not report success when execution insertion fails', async () => {
    const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
    const db = buildDb();
    db.insert
      .mockReturnValueOnce({ values: jest.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({
        values: jest.fn().mockRejectedValue(new Error('database unavailable')),
      });
    getDb.mockReturnValueOnce(db);
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(
      (jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock }).addJob
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('marks the created execution failed when queue submission fails', async () => {
    const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
    const db = buildDb();
    db.update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    });
    getDb.mockReturnValueOnce(db);
    (
      jest.requireMock('@pullmint/shared/queue') as { addJob: jest.Mock }
    ).addJob.mockRejectedValueOnce(new Error('redis unavailable secret=hidden'));
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/dashboard/repos/org/repo/prs/42/analyze',
      headers: VALID_AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret=hidden');
    expect(db.update).toHaveBeenCalled();
    await app.close();
  });
});
