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
      status: 'status',
      riskScore: 'riskScore',
      findings: 'findings',
      createdAt: 'createdAt',
      metadata: 'metadata',
      deploymentStartedAt: 'deploymentStartedAt',
    },
    tokenUsage: {
      executionId: 'executionId',
      repoFullName: 'repoFullName',
      agentType: 'agentType',
      model: 'model',
      inputTokens: 'inputTokens',
      outputTokens: 'outputTokens',
      estimatedCostUsd: 'estimatedCostUsd',
      createdAt: 'createdAt',
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
  QUEUE_NAMES: { REPO_INDEXING: 'repo-indexing' },
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

jest.mock('drizzle-orm', () => ({
  sql: jest.fn((s: TemplateStringsArray) => ({ raw: s.join('?') })),
  eq: jest.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: jest.fn((...args: unknown[]) => args),
  desc: jest.fn((a: unknown) => ({ desc: a })),
  inArray: jest.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));

const VALID_AUTH = 'Bearer test-token';

function buildDbWithSelectResults(resultsQueue: unknown[][]) {
  const select = jest.fn().mockImplementation(() => {
    const result = resultsQueue.shift() ?? [];

    const whereReturn = {
      groupBy: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue(result),
      }),
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(result),
      }),
      limit: jest.fn().mockResolvedValue(result),
      then: (resolve: (value: unknown[]) => unknown) => resolve(result),
    };

    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(whereReturn),
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(result),
          }),
        }),
      }),
    };
  });

  return { select };
}

describe('GET /dashboard/analytics/costs', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
    getDb.mockReturnValue(
      buildDbWithSelectResults([
        [{ totalCostUsd: 10.5, totalInputTokens: 50000, totalOutputTokens: 10000 }],
        [{ repoFullName: 'org/repo', costUsd: 10.5, prCount: 3 }],
        [{ agentType: 'architecture', costUsd: 4.2, callCount: 5 }],
        [{ model: 'claude-sonnet-4-6', costUsd: 9.9, tokenCount: 60000 }],
        [{ date: '2026-03-25', costUsd: 10.5, prCount: 3 }],
      ])
    );

    app = Fastify();
    registerDashboardRoutes(app);
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/analytics/costs' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with cost analytics payload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/analytics/costs',
      headers: { authorization: VALID_AUTH },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('totalCostUsd');
    expect(body).toHaveProperty('byRepo');
    expect(body).toHaveProperty('byAgent');
    expect(body).toHaveProperty('byModel');
    expect(body).toHaveProperty('dailyTrend');
  });
});

describe('GET /dashboard/analytics/costs/budget-status', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    const { getDb } = jest.requireMock('@pullmint/shared/db') as { getDb: jest.Mock };
    getDb.mockReturnValue(
      buildDbWithSelectResults([
        [
          {
            repoFullName: 'org/repo',
            usedUsd: 25.25,
            totalTokens: 25000,
            dayCount: 5,
          },
        ],
        [{ metadata: { repoConfig: { monthly_budget_usd: 50 } } }],
      ])
    );

    app = Fastify();
    registerDashboardRoutes(app);
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('returns 200 and repo array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/analytics/costs/budget-status',
      headers: { authorization: VALID_AUTH },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('repos');
    expect(body).toHaveProperty('resetDate');
    expect(Array.isArray(body.repos)).toBe(true);
  });
});
