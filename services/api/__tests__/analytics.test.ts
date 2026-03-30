import Fastify from 'fastify';
import { registerDashboardRoutes } from '../src/routes/dashboard';
import { getDb } from '@pullmint/shared/db';

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

const mockGetDb = getDb as jest.Mock;

function mockExecute(rowsList: unknown[][]) {
  let callIndex = 0;
  return jest.fn().mockImplementation(() => {
    const rows = rowsList[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(rows);
  });
}

const VALID_AUTH = 'Bearer test-token';

async function buildApp() {
  const app = Fastify({ logger: false });
  registerDashboardRoutes(app);
  return app;
}

describe('Analytics Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Summary ---

  describe('GET /dashboard/analytics/summary', () => {
    it('returns org summary with aggregated data', async () => {
      const summaryRow = {
        totalPRsAnalyzed: 50,
        avgRiskScore: '28.5',
        medianRiskScore: '22',
        highRiskPRs: 8,
        autoApproved: 30,
        held: 10,
        rolledBack: 2,
        avgAnalysisTimeMs: 12000,
      };
      const findingRows = [
        { type: 'security', count: 40 },
        { type: 'architecture', count: 20 },
      ];
      mockGetDb.mockReturnValue({
        execute: mockExecute([[summaryRow], findingRows]),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/summary',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalPRsAnalyzed).toBe(50);
      expect(body.avgRiskScore).toBe(28.5);
      expect(body.medianRiskScore).toBe(22);
      expect(body.highRiskPRs).toBe(8);
      expect(body.autoApproved).toBe(30);
      expect(body.held).toBe(10);
      expect(body.rolledBack).toBe(2);
      expect(body.avgAnalysisTimeMs).toBe(12000);
      expect(body.topFindingTypes).toEqual([
        { type: 'security', count: 40 },
        { type: 'architecture', count: 20 },
      ]);
    });

    it('returns sensible defaults when no executions exist (empty state)', async () => {
      mockGetDb.mockReturnValue({
        execute: mockExecute([
          [
            {
              totalPRsAnalyzed: 0,
              avgRiskScore: null,
              medianRiskScore: null,
              highRiskPRs: 0,
              autoApproved: 0,
              held: 0,
              rolledBack: 0,
              avgAnalysisTimeMs: null,
            },
          ],
          [],
        ]),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/summary',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalPRsAnalyzed).toBe(0);
      expect(body.avgRiskScore).toBe(0);
      expect(body.topFindingTypes).toEqual([]);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/summary',
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts dateFrom and dateTo query params', async () => {
      const execute = mockExecute([
        [
          {
            totalPRsAnalyzed: 5,
            avgRiskScore: '10',
            medianRiskScore: '10',
            highRiskPRs: 0,
            autoApproved: 5,
            held: 0,
            rolledBack: 0,
            avgAnalysisTimeMs: 5000,
          },
        ],
        [],
      ]);
      mockGetDb.mockReturnValue({
        execute,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/summary?dateFrom=2026-03-01&dateTo=2026-03-25',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        totalPRsAnalyzed: 5,
        avgRiskScore: 10,
        medianRiskScore: 10,
        highRiskPRs: 0,
        autoApproved: 5,
        held: 0,
        rolledBack: 0,
        avgAnalysisTimeMs: 5000,
        topFindingTypes: [],
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  // --- Trends ---

  describe('GET /dashboard/analytics/trends', () => {
    const bucketRows = [
      { date: new Date('2026-03-01'), avgRisk: '25', prCount: 12, rollbackCount: 0 },
      { date: new Date('2026-03-02'), avgRisk: '31', prCount: 8, rollbackCount: 1 },
    ];

    it('returns time-bucketed data for default day interval', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([bucketRows]) });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/trends',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.buckets).toHaveLength(2);
      expect(body.buckets[0]).toEqual({
        date: '2026-03-01',
        avgRisk: 25,
        prCount: 12,
        rollbackCount: 0,
      });
    });

    it('accepts week and month interval params', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([[]]) });

      const resWeek = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/trends?interval=week',
        headers: { Authorization: VALID_AUTH },
      });
      expect(resWeek.statusCode).toBe(200);

      mockGetDb.mockReturnValue({ execute: mockExecute([[]]) });

      const resMonth = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/trends?interval=month',
        headers: { Authorization: VALID_AUTH },
      });
      expect(resMonth.statusCode).toBe(200);
    });

    it('defaults to day interval for unknown interval param', async () => {
      const execute = mockExecute([[]]);
      mockGetDb.mockReturnValue({ execute });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/trends?interval=invalid',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ buckets: [] });

      const executedSql = JSON.stringify(execute.mock.calls[0]?.[0] ?? {});
      expect(executedSql).toContain('day');
      expect(executedSql).not.toContain('invalid');
    });

    it('returns empty buckets array when no executions exist', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([[]]) });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/trends',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().buckets).toEqual([]);
    });
  });

  // --- Authors ---

  describe('GET /dashboard/analytics/authors', () => {
    const authorRows = [
      {
        login: 'alice',
        prCount: 15,
        avgRiskScore: '22',
        rollbackRate: '0',
        recent_avg: '18',
        prev_avg: '25',
      },
      {
        login: 'bob',
        prCount: 8,
        avgRiskScore: '45',
        rollbackRate: '0.125',
        recent_avg: '50',
        prev_avg: '40',
      },
    ];
    const findingRows = [
      { author: 'alice', type: 'architecture', cnt: 30 },
      { author: 'alice', type: 'security', cnt: 20 },
      { author: 'bob', type: 'security', cnt: 15 },
    ];

    it('returns ranked author list with trend calculation', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([authorRows, findingRows]) });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/authors',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.authors).toHaveLength(2);

      const alice = body.authors[0];
      expect(alice.login).toBe('alice');
      expect(alice.prCount).toBe(15);
      expect(alice.avgRiskScore).toBe(22);
      expect(alice.topFindingType).toBe('architecture');
      // alice recent_avg=18, prev_avg=25 → (18-25)/25 = -28% → improving
      expect(alice.trend).toBe('improving');

      const bob = body.authors[1];
      // bob recent_avg=50, prev_avg=40 → (50-40)/40 = +25% → declining
      expect(bob.trend).toBe('declining');
      expect(bob.rollbackRate).toBeCloseTo(0.125);
    });

    it('returns stable trend when fewer than 10 PRs (no prev_avg)', async () => {
      mockGetDb.mockReturnValue({
        execute: mockExecute([
          [
            {
              login: 'newdev',
              prCount: 3,
              avgRiskScore: '30',
              rollbackRate: '0',
              recent_avg: '30',
              prev_avg: null,
            },
          ],
          [],
        ]),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/authors',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().authors[0].trend).toBe('stable');
    });

    it('respects limit param (max 100)', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([[], []]) });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/authors?limit=200',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns empty authors array for empty date range', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([[], []]) });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/authors',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().authors).toEqual([]);
    });

    it('filters by date range', async () => {
      const execute = mockExecute([authorRows, findingRows]);
      mockGetDb.mockReturnValue({ execute });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/authors?dateFrom=2026-03-01&dateTo=2026-03-25',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().authors).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  // --- Repos ---

  describe('GET /dashboard/analytics/repos', () => {
    const repoRows = [
      {
        repoFullName: 'org/api',
        prCount: 45,
        avgRiskScore: '30',
        rollbackRate: '0.02',
        calibrationFactor: 0.95,
      },
      {
        repoFullName: 'org/frontend',
        prCount: 20,
        avgRiskScore: '18',
        rollbackRate: '0',
        calibrationFactor: null,
      },
    ];
    const repoFindingRows = [
      { repoFullName: 'org/api', type: 'security', cnt: 50 },
      { repoFullName: 'org/api', type: 'architecture', cnt: 30 },
      { repoFullName: 'org/frontend', type: 'style', cnt: 25 },
    ];

    it('returns per-repo stats joined with calibration data', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([repoRows, repoFindingRows]) });

      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/repos',
        headers: { Authorization: VALID_AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.repos).toHaveLength(2);

      const api = body.repos[0];
      expect(api.repoFullName).toBe('org/api');
      expect(api.prCount).toBe(45);
      expect(api.avgRiskScore).toBe(30);
      expect(api.rollbackRate).toBeCloseTo(0.02);
      expect(api.calibrationFactor).toBeCloseTo(0.95);
      expect(api.topFindingTypes).toEqual(['security', 'architecture']);

      const frontend = body.repos[1];
      expect(frontend.calibrationFactor).toBeNull();
      expect(frontend.topFindingTypes).toEqual(['style']);
    });

    it('returns empty repos array for empty date range', async () => {
      mockGetDb.mockReturnValue({ execute: mockExecute([[], []]) });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/repos',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos).toEqual([]);
    });

    it('handles repos with no calibration record (null calibrationFactor)', async () => {
      mockGetDb.mockReturnValue({
        execute: mockExecute([
          [
            {
              repoFullName: 'org/new',
              prCount: 5,
              avgRiskScore: '20',
              rollbackRate: '0',
              calibrationFactor: null,
            },
          ],
          [],
        ]),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/analytics/repos',
        headers: { Authorization: VALID_AUTH },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().repos[0].calibrationFactor).toBeNull();
    });
  });
});
