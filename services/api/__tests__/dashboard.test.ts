import Fastify from 'fastify';
import { registerDashboardRoutes } from '../src/routes/dashboard';

// Mock shared modules
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

jest.mock('@pullmint/shared/notifications', () => ({
  sendNotification: jest.fn().mockResolvedValue(undefined),
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
}));

const VALID_AUTH = 'Bearer test-token';

const sampleExecution = {
  executionId: 'exec-1',
  repoFullName: 'org/repo',
  prNumber: 42,
  headSha: 'abc',
  baseSha: 'def',
  author: 'dev',
  title: 'Test PR',
  orgId: 'org_1',
  status: 'completed',
  riskScore: 0.5,
  confidenceScore: 0.9,
  checkpoints: [],
  timestamp: Date.now(),
  entityType: 'execution',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildSelectChain(rows: unknown[] = []) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(rows),
          }),
        }),
        limit: jest.fn().mockResolvedValue(rows),
      }),
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          offset: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
}

function buildStatsDbMock({
  trendRows,
  summaryRows,
  onTrendLimit,
}: {
  trendRows: unknown[];
  summaryRows: unknown[];
  onTrendLimit?: jest.Mock;
}) {
  const trendLimit = jest.fn().mockImplementation((value: number) => {
    if (onTrendLimit) {
      onTrendLimit(value);
    }
    return Promise.resolve(trendRows);
  });

  const trendOrderBy = jest.fn().mockReturnValue({
    limit: trendLimit,
  });

  const trendWhere = jest.fn().mockReturnValue({
    orderBy: trendOrderBy,
  });

  const summaryWhere = jest.fn().mockResolvedValue(summaryRows);

  const trendFrom = jest.fn().mockReturnValue({ where: trendWhere });
  const summaryFrom = jest.fn().mockReturnValue({ where: summaryWhere });

  return {
    select: jest
      .fn()
      .mockReturnValueOnce({ from: trendFrom })
      .mockReturnValueOnce({ from: summaryFrom }),
    trendLimit,
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  // Add content type parser for JSON (needed by some POST endpoints)
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

describe('Dashboard Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Authentication', () => {
    it('returns 401 for missing Authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 for wrong token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 for wrong token with different length', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions',
        headers: { authorization: 'Bearer x' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/executions', () => {
    it('returns list of executions', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([sampleExecution]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { executions: unknown[]; count: number };
      expect(body.count).toBe(1);
      expect(body.executions).toHaveLength(1);
    });

    it('returns empty list when no executions', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { executions: unknown[]; count: number };
      expect(body.count).toBe(0);
    });
  });

  describe('POST /dashboard/notifications', () => {
    it('returns 422 when webhook URL fails SSRF validation', async () => {
      const { validateWebhookUrl } = jest.requireMock('@pullmint/shared/notifications') as {
        validateWebhookUrl: jest.Mock;
      };
      validateWebhookUrl.mockResolvedValueOnce({ valid: false, reason: 'Blocked hostname' });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/notifications',
        headers: {
          authorization: VALID_AUTH,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Security Alerts',
          channelType: 'webhook',
          webhookUrl: 'http://localhost/hook',
          events: ['analysis.completed'],
        }),
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body) as { error: string; reason: string };
      expect(body.error).toBe('Invalid webhook URL');
      expect(body.reason).toContain('Blocked hostname');
    });

    it('creates notification channel when webhook URL is valid', async () => {
      const { validateWebhookUrl } = jest.requireMock('@pullmint/shared/notifications') as {
        validateWebhookUrl: jest.Mock;
      };
      validateWebhookUrl.mockResolvedValueOnce({ valid: true });

      const created = {
        id: 1,
        name: 'Security Alerts',
        channelType: 'webhook',
        webhookUrl: 'https://hooks.example.com/hook',
        repoFilter: null,
        events: ['analysis.completed'],
        minRiskScore: null,
        enabled: true,
        secret: null,
      };

      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([created]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/notifications',
        headers: {
          authorization: VALID_AUTH,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Security Alerts',
          channelType: 'webhook',
          webhookUrl: 'https://hooks.example.com/hook',
          events: ['analysis.completed'],
        }),
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { channel: { id: number } };
      expect(body.channel.id).toBe(1);
    });
  });

  describe('GET /dashboard/executions/:executionId', () => {
    it('returns 404 when execution not found', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/nonexistent',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns execution when found', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([sampleExecution]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/exec-1',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { executionId: string };
      expect(body.executionId).toBe('exec-1');
    });
  });

  describe('GET /dashboard/executions/:executionId/checkpoints', () => {
    it('returns 404 when execution not found', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/nonexistent/checkpoints',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns checkpoint data for existing execution', async () => {
      const executionWithCheckpoints = {
        ...sampleExecution,
        checkpoints: [{ type: 'analysis', completedAt: Date.now() }],
        signalsReceived: { 'ci.result:123': { value: 'passed' } },
        repoContext: { modules: ['src/'] },
        calibrationApplied: 1.1,
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([executionWithCheckpoints]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions/exec-1/checkpoints',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executionId: string;
        checkpoints: unknown[];
        calibrationApplied: number;
      };
      expect(body.executionId).toBe('exec-1');
      expect(body.checkpoints).toHaveLength(1);
      expect(body.calibrationApplied).toBe(1.1);
    });
  });

  describe('GET /dashboard/calibration', () => {
    it('returns calibration list sorted by factor', async () => {
      const calibrations = [
        { repoFullName: 'org/a', calibrationFactor: 0.8 },
        { repoFullName: 'org/b', calibrationFactor: 1.2 },
      ];
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockResolvedValue(calibrations),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/calibration',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { repos: { calibrationFactor: number }[] };
      // Should be sorted descending by calibrationFactor
      expect(body.repos[0].calibrationFactor).toBe(1.2);
    });
  });

  describe('POST /dashboard/executions/:executionId/re-evaluate', () => {
    it('returns 202 when re-evaluation is logged', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]), // no rate limit hit
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
        execute: jest.fn().mockResolvedValue(undefined),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-1/re-evaluate',
        headers: {
          authorization: VALID_AUTH,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ justification: 'Looks safe to deploy' }),
      });

      expect(response.statusCode).toBe(202);
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ deliveryId: 'reeval:exec-1' }]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/executions/exec-1/re-evaluate',
        headers: {
          authorization: VALID_AUTH,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.statusCode).toBe(429);
    });
  });

  describe('GET /dashboard/board', () => {
    it('returns board grouped by status', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const mockSelect = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([sampleExecution]),
        }),
      });
      getDb.mockReturnValue({ select: mockSelect });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/board',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { board: Record<string, unknown[]> };
      expect(body.board).toBeDefined();
      expect(typeof body.board).toBe('object');
    });
  });

  describe('GET /dashboard/repos/:owner/:repo', () => {
    it('returns 404 for unknown repo', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/repos/org/unknown-repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns repo registry item when found', async () => {
      const repoItem = {
        repoFullName: 'org/known-repo',
        indexingStatus: 'indexed',
        contextVersion: 1,
        pendingBatches: 0,
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([repoItem]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/repos/org/known-repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { repoFullName: string };
      expect(body.repoFullName).toBe('org/known-repo');
    });
  });

  describe('GET /dashboard/executions with query filters', () => {
    it('filters by repo and status', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([sampleExecution]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?repo=org%2Frepo&status=completed',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
    });

    it('filters by status only', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([sampleExecution]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?status=analyzing',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
    });

    it('filters by repo only', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([sampleExecution]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?repo=org%2Frepo',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
    });

    it('filters by search term (repo name substring)', async () => {
      const expected = { ...sampleExecution, repoFullName: 'org/frontend', executionId: 'exec-fe' };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?search=frontend',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executions: { repoFullName: string }[];
        count: number;
      };
      expect(body.count).toBe(1);
      expect(body.executions[0]?.repoFullName).toBe('org/frontend');
    });

    it('filters by search term (PR number)', async () => {
      const expected = { ...sampleExecution, prNumber: 42, executionId: 'exec-pr-42' };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?search=42',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executions: { prNumber: number }[];
        count: number;
      };
      expect(body.count).toBe(1);
      expect(body.executions[0]?.prNumber).toBe(42);
    });

    it('filters by date range', async () => {
      const expected = {
        ...sampleExecution,
        executionId: 'exec-date-range',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?dateFrom=2026-03-24&dateTo=2026-03-25',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { count: number };
      expect(body.count).toBe(1);
    });

    it('filters by author', async () => {
      const expected = { ...sampleExecution, executionId: 'exec-author', author: 'alice' };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?author=alice',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executions: { author: string }[];
      };
      expect(body.executions[0]?.author).toBe('alice');
    });

    it('filters by risk score range', async () => {
      const expected = { ...sampleExecution, executionId: 'exec-risk', riskScore: 72 };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?riskMin=50&riskMax=80',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executions: { riskScore: number }[];
      };
      expect(body.executions[0]?.riskScore).toBe(72);
    });

    it('filters by finding type via JSONB containment', async () => {
      const expected = {
        ...sampleExecution,
        executionId: 'exec-finding-type',
        findings: [{ type: 'security', severity: 'high', title: 'test finding' }],
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?findingType=security',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        executions: { findings?: { type?: string }[] }[];
      };
      expect(body.executions[0]?.findings?.[0]?.type).toBe('security');
    });

    it('combines multiple filters', async () => {
      const expected = {
        ...sampleExecution,
        executionId: 'exec-combined-filter',
        repoFullName: 'org/repo',
        author: 'alice',
        riskScore: 35,
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([expected]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/executions?repo=org%2Frepo&author=alice&riskMin=30',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { count: number };
      expect(body.count).toBe(1);
    });
  });

  describe('GET /dashboard/stats/:owner/:repo', () => {
    it('returns trend data in chronological order', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const trendRows = [
        { prNumber: 5, riskScore: 50, createdAt: new Date('2026-03-25T00:00:00.000Z') },
        { prNumber: 4, riskScore: 40, createdAt: new Date('2026-03-24T00:00:00.000Z') },
        { prNumber: 3, riskScore: 30, createdAt: new Date('2026-03-23T00:00:00.000Z') },
        { prNumber: 2, riskScore: 20, createdAt: new Date('2026-03-22T00:00:00.000Z') },
        { prNumber: 1, riskScore: 10, createdAt: new Date('2026-03-21T00:00:00.000Z') },
      ];

      getDb.mockReturnValue(
        buildStatsDbMock({
          trendRows,
          summaryRows: [
            {
              total: 5,
              avgRisk: 30,
              confirmedCount: 3,
              rolledBackCount: 2,
            },
          ],
        })
      );

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats/org/repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        trends: { riskScores: { prNumber: number }[] };
      };
      expect(body.trends.riskScores.map((item) => item.prNumber)).toEqual([1, 2, 3, 4, 5]);
    });

    it('returns at most 30 entries', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const onTrendLimit = jest.fn();
      const trendRows = Array.from({ length: 30 }, (_, index) => ({
        prNumber: index + 1,
        riskScore: index,
        createdAt: new Date(`2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
      }));

      getDb.mockReturnValue(
        buildStatsDbMock({
          trendRows,
          summaryRows: [
            {
              total: 30,
              avgRisk: 15,
              confirmedCount: 20,
              rolledBackCount: 10,
            },
          ],
          onTrendLimit,
        })
      );

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats/org/repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        trends: { riskScores: unknown[] };
      };
      expect(onTrendLimit).toHaveBeenCalledWith(30);
      expect(body.trends.riskScores.length).toBeLessThanOrEqual(30);
    });

    it('returns summary statistics', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };

      getDb.mockReturnValue(
        buildStatsDbMock({
          trendRows: [
            {
              prNumber: 101,
              riskScore: 58,
              createdAt: new Date('2026-03-24T00:00:00.000Z'),
            },
          ],
          summaryRows: [
            {
              total: 10,
              avgRisk: 57.4,
              confirmedCount: 7,
              rolledBackCount: 3,
            },
          ],
        })
      );

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats/org/repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        summary: { totalExecutions: number; avgRiskScore: number; successRate: number };
      };
      expect(body.summary.totalExecutions).toBe(10);
      expect(body.summary.avgRiskScore).toBe(57);
      expect(body.summary.successRate).toBe(70);
    });

    it('handles repo with no executions', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };

      getDb.mockReturnValue(
        buildStatsDbMock({
          trendRows: [],
          summaryRows: [
            {
              total: 0,
              avgRisk: null,
              confirmedCount: 0,
              rolledBackCount: 0,
            },
          ],
        })
      );

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats/org/empty-repo',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        trends: { riskScores: unknown[] };
        summary: { totalExecutions: number; avgRiskScore: number; successRate: number };
      };
      expect(body.trends.riskScores).toHaveLength(0);
      expect(body.summary.totalExecutions).toBe(0);
      expect(body.summary.avgRiskScore).toBe(0);
      expect(body.summary.successRate).toBe(0);
    });

    it('requires auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats/org/repo',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/calibration/:owner/:repo', () => {
    it('returns 404 when calibration record not found', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/calibration/org/nocalib',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns calibration record when found', async () => {
      const calibration = { repoFullName: 'org/calibrated', calibrationFactor: 1.1 };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([calibration]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/calibration/org/calibrated',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { repoFullName: string };
      expect(body.repoFullName).toBe('org/calibrated');
    });
  });

  describe('POST /dashboard/repos/:owner/:repo/reindex', () => {
    it('returns 404 when repo not registered', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/notregistered/reindex',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 202 when reindex is triggered', async () => {
      const repoItem = { repoFullName: 'org/registered', indexingStatus: 'indexed' };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([repoItem]),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/registered/reindex',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { message: string };
      expect(body.message).toBe('Reindex triggered');
    });
  });

  describe('GET /dashboard/repos/:owner/:repo/prs/:number', () => {
    it('returns executions for a specific PR', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([sampleExecution]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/repos/org/repo/prs/42',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { count: number };
      expect(typeof body.count).toBe('number');
    });

    it('handles empty PR execution list', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({ select: buildSelectChain([]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/repos/org/repo/prs/999',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { count: number };
      expect(body.count).toBe(0);
    });

    it('handles multiple executions in PR', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const exec1 = { ...sampleExecution, executionId: 'pr-42-exec-1', status: 'completed' };
      const exec2 = { ...sampleExecution, executionId: 'pr-42-exec-2', status: 'analyzing' };
      getDb.mockReturnValue({ select: buildSelectChain([exec1, exec2]) });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/repos/org/repo/prs/42',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { count: number };
      expect(body.count).toBe(2);
    });
  });

  describe('GET /dashboard/board - status grouping', () => {
    it('groups executions by different statuses', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const completed = { ...sampleExecution, status: 'completed' };
      const analyzing = { ...sampleExecution, status: 'analyzing' };
      const failed = { ...sampleExecution, status: 'failed' };

      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([completed, analyzing, failed]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/board',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { board: Record<string, unknown[]> };
      expect(body.board).toBeDefined();
    });
  });

  describe('POST /dashboard/repos/:owner/:repo/reindex - multiple states', () => {
    it('reindex succeeds when repo has pending batches', async () => {
      const repoWithPending = {
        repoFullName: 'org/pending-repo',
        indexingStatus: 'indexed',
        pendingBatches: 5,
      };
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([repoWithPending]),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/repos/org/pending-repo/reindex',
        headers: { authorization: VALID_AUTH },
      });
      expect(response.statusCode).toBe(202);
    });
  });

  describe('GET /dashboard/calibration - sorting', () => {
    it('sorts calibration factors correctly', async () => {
      const calibrations = [
        { repoFullName: 'org/low', calibrationFactor: 0.5 },
        { repoFullName: 'org/high', calibrationFactor: 2.0 },
        { repoFullName: 'org/mid', calibrationFactor: 1.0 },
      ];
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockResolvedValue(calibrations),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/calibration',
        headers: { authorization: VALID_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { repos: { calibrationFactor: number }[] };
      // Verify descending order
      expect(body.repos[0].calibrationFactor).toBeGreaterThanOrEqual(
        body.repos[1].calibrationFactor
      );
    });
  });
});
