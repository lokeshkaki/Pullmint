// services/e2e/__tests__/dashboard-api.test.ts
import nock from 'nock';
import Fastify from 'fastify';
import crypto from 'crypto';
import EventSource from 'eventsource';
import { startWorkers, stopWorkers } from '../src/workers';
import {
  mockGitHubAppAuth,
  mockGetDiff,
  mockNoPullmintConfig,
  mockGetCheckRuns,
  mockCreateReview,
} from '../src/helpers/mock-github';
import { mockLLMForAgents, cleanupLLMMocks } from '../src/helpers/mock-llm';
import { buildWebhookPayload } from '../src/helpers/fixtures';
import { waitForExecutionStatus } from '../src/helpers/wait-for';
import { getDb, schema } from '@pullmint/shared/db';
import { eq } from 'drizzle-orm';

const describeE2E = process.env.RUN_E2E_TESTS === 'true' ? describe : describe.skip;

describeE2E('Dashboard API E2E', () => {
  let app: ReturnType<typeof Fastify>;
  let serverAddress: string;

  beforeAll(async () => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    nock.enableNetConnect('::1');

    app = Fastify({ logger: false });
    const { registerWebhookRoutes } = await import('../../api/src/routes/webhook');
    const { registerDashboardRoutes } = await import('../../api/src/routes/dashboard');
    const { registerEventRoutes } = await import('../../api/src/routes/events');
    const { registerHealthRoutes } = await import('../../api/src/routes/health');

    registerHealthRoutes(app);
    registerWebhookRoutes(app);
    registerDashboardRoutes(app);
    registerEventRoutes(app);

    await app.ready();
    // Listen on a real port for EventSource (which needs a real TCP connection)
    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' });

    await startWorkers();
  }, 30000);

  afterAll(async () => {
    await stopWorkers();
    await app.close();
    nock.enableNetConnect();
    cleanupLLMMocks();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  // -------------------------------------------------------------------------
  // Test 1: Dashboard shows completed execution
  // -------------------------------------------------------------------------
  it('completed execution appears in dashboard executions list', async () => {
    const repoFullName = `test-org/dashboard-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber = 601;
    const headSha = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber });
    mockNoPullmintConfig({ owner, repo, headSha });
    mockGetCheckRuns({ owner, repo, headSha });
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);
    mockCreateReview({ owner, repo, prNumber });

    const { payload, signature, deliveryId } = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha,
      baseSha,
      action: 'opened',
    });

    // Trigger pipeline via real HTTP (using app.inject for webhook)
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.repoFullName, repoFullName))
      .limit(1);

    await waitForExecutionStatus(row.executionId, ['completed']);

    // Query dashboard API
    const dashboardResponse = await app.inject({
      method: 'GET',
      url: `/dashboard/executions?repo=${encodeURIComponent(repoFullName)}`,
      headers: {
        authorization: `Bearer ${process.env.DASHBOARD_AUTH_TOKEN}`,
      },
    });

    expect(dashboardResponse.statusCode).toBe(200);
    const body = JSON.parse(dashboardResponse.body) as {
      executions: Array<Record<string, unknown>>;
    };
    expect(body.executions.length).toBeGreaterThanOrEqual(1);

    const found = body.executions.find((e) => e.executionId === row.executionId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('completed');
    expect(typeof found!.riskScore).toBe('number');
    expect(Array.isArray(found!.findings)).toBe(true);
  }, 90000);

  // -------------------------------------------------------------------------
  // Test 2: SSE delivers real-time status updates
  // -------------------------------------------------------------------------
  it('SSE endpoint delivers execution status updates during pipeline run', async () => {
    const repoFullName = `test-org/sse-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber = 701;
    const headSha = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber });
    mockNoPullmintConfig({ owner, repo, headSha });
    mockGetCheckRuns({ owner, repo, headSha });
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);
    mockCreateReview({ owner, repo, prNumber });

    // Collect SSE events
    const receivedEvents: Array<{ status: string }> = [];
    const token = process.env.DASHBOARD_AUTH_TOKEN!;
    const sseUrl = `${serverAddress}/dashboard/events?token=${encodeURIComponent(token)}&repo=${encodeURIComponent(repoFullName)}`;

    const es = new EventSource(sseUrl);
    es.addEventListener('execution-update', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { status?: string };
        if (data.status) receivedEvents.push({ status: data.status });
      } catch {
        // ignore parse errors
      }
    });

    // Wait briefly for SSE connection to establish
    await new Promise((r) => setTimeout(r, 500));

    // Trigger webhook
    const { payload, signature, deliveryId } = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha,
      baseSha,
      action: 'opened',
    });

    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.repoFullName, repoFullName))
      .limit(1);

    await waitForExecutionStatus(row.executionId, ['completed', 'failed']);

    es.close();

    // We should have received at least one status update via SSE
    expect(receivedEvents.length).toBeGreaterThan(0);

    const statuses = receivedEvents.map((e) => e.status);
    // The final event should be 'completed' (or 'failed')
    expect(statuses).toContain('completed');
  }, 90000);
});
