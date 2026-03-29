// services/e2e/__tests__/edge-cases.test.ts
import nock from 'nock';
import Fastify from 'fastify';
import crypto from 'crypto';
import { startWorkers, stopWorkers } from '../src/workers';
import {
  mockGitHubAppAuth,
  mockGetDiff,
  mockNoPullmintConfig,
  mockGetCheckRuns,
  mockCreateReview,
} from '../src/helpers/mock-github';
import { mockLLMForAgents, cleanupLLMMocks } from '../src/helpers/mock-llm';
import { buildWebhookPayload, SAMPLE_DIFF_LARGE, SAMPLE_DIFF_SMALL } from '../src/helpers/fixtures';
import { waitForExecutionStatus } from '../src/helpers/wait-for';
import { getDb, schema } from '@pullmint/shared/db';
import { eq, and, desc } from 'drizzle-orm';

const describeE2E = process.env.RUN_E2E_TESTS === 'true' ? describe : describe.skip;

describeE2E('Edge case pipeline tests', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    nock.disableNetConnect();
    nock.enableNetConnect(/^(127\.0\.0\.1|::1)(:\d+)?$/);

    app = Fastify({ logger: false });
    const { registerWebhookRoutes } = await import('../../api/src/routes/webhook');
    registerWebhookRoutes(app);
    await app.ready();

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
  // Test 1: Duplicate webhook deduplication
  // -------------------------------------------------------------------------
  it('duplicate webhook delivery is deduplicated — only one execution created', async () => {
    const repoFullName = `test-org/dedup-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber = 201;
    const headSha = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');
    const deliveryId = `dedup-delivery-${crypto.randomBytes(8).toString('hex')}`;

    // Same deliveryId for both webhooks
    const { payload, signature } = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha,
      baseSha,
      action: 'opened',
      deliveryId,
    });

    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber }).persist(); // allow multiple calls
    mockNoPullmintConfig({ owner, repo, headSha }).persist();
    mockGetCheckRuns({ owner, repo, headSha }).persist();
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);
    mockCreateReview({ owner, repo, prNumber });

    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
      'content-type': 'application/json',
    };

    // POST same webhook twice
    const r1 = await app.inject({ method: 'POST', url: '/webhook', headers, payload });
    const r2 = await app.inject({ method: 'POST', url: '/webhook', headers, payload });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200); // 200 even on dedup (idempotent)

    // Wait for first execution to complete
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.repoFullName, repoFullName));

    // Only one execution row should exist
    expect(rows.length).toBe(1);

    const completed = await waitForExecutionStatus(rows[0].executionId, ['completed', 'failed']);
    expect(completed.status).toBe('completed');
  }, 90000);

  // -------------------------------------------------------------------------
  // Test 2: Small diff triggers 2-agent analysis
  // -------------------------------------------------------------------------
  it('small diff (< MULTI_AGENT_MIN_DIFF_LINES) triggers only architecture + security agents', async () => {
    // MULTI_AGENT_MIN_DIFF_LINES set to 5 in test-env.ts, SAMPLE_DIFF_SMALL is 3 lines
    const repoFullName = `test-org/small-diff-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber = 301;
    const headSha = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber, diff: SAMPLE_DIFF_SMALL });
    mockNoPullmintConfig({ owner, repo, headSha });
    mockGetCheckRuns({ owner, repo, headSha });
    // Only 2 agents + synthesis
    mockLLMForAgents(['architecture', 'security']);
    mockCreateReview({ owner, repo, prNumber });

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

    const completed = await waitForExecutionStatus(row.executionId, ['completed', 'failed']);
    expect(completed.status).toBe('completed');

    // Assert only 2 agent types present in metadata
    const metadata = (completed.metadata as Record<string, unknown>) ?? {};
    const agentTypes = (metadata.agentTypes as string[]) ?? [];
    expect(agentTypes).toHaveLength(2);
    expect(agentTypes).toContain('architecture');
    expect(agentTypes).toContain('security');
    expect(agentTypes).not.toContain('performance');
    expect(agentTypes).not.toContain('style');
  }, 90000);

  // -------------------------------------------------------------------------
  // Test 3: Rate-limited PR returns cached result on second webhook
  // -------------------------------------------------------------------------
  it('second PR webhook for same repo within rate limit window returns cached result', async () => {
    // Set a very low rate limit so the second call hits the cache
    process.env.LLM_HOURLY_LIMIT_PER_REPO = '1';

    const repoFullName = `test-org/cached-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber1 = 401;
    const prNumber2 = 402;
    const headSha1 = crypto.randomBytes(20).toString('hex');
    const headSha2 = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    // First analysis — full pipeline
    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber: prNumber1 });
    mockNoPullmintConfig({ owner, repo, headSha: headSha1 });
    mockGetCheckRuns({ owner, repo, headSha: headSha1 });
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);
    mockCreateReview({ owner, repo, prNumber: prNumber1 });

    const w1 = buildWebhookPayload({
      repoFullName,
      prNumber: prNumber1,
      headSha: headSha1,
      baseSha,
    });
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': w1.deliveryId,
        'x-hub-signature-256': w1.signature,
        'content-type': 'application/json',
      },
      payload: w1.payload,
    });

    const db = getDb();
    const [row1] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.repoFullName, repoFullName))
      .limit(1);

    await waitForExecutionStatus(row1.executionId, ['completed']);

    // Second analysis — should hit rate limit → status: rate_limited (no LLM calls needed)
    mockGetDiff({ owner, repo, prNumber: prNumber2 });
    mockNoPullmintConfig({ owner, repo, headSha: headSha2 });
    // No LLM mocks needed — rate-limited path skips LLM

    const w2 = buildWebhookPayload({
      repoFullName,
      prNumber: prNumber2,
      headSha: headSha2,
      baseSha,
    });
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': w2.deliveryId,
        'x-hub-signature-256': w2.signature,
        'content-type': 'application/json',
      },
      payload: w2.payload,
    });

    const [row2] = await db
      .select()
      .from(schema.executions)
      .where(
        and(
          eq(schema.executions.repoFullName, repoFullName),
          eq(schema.executions.prNumber, prNumber2)
        )
      )
      .limit(1);

    const completed2 = await waitForExecutionStatus(row2.executionId, [
      'completed',
      'rate_limited',
    ]);
    expect(completed2.status).toBe('rate_limited');

    // Restore rate limit
    process.env.LLM_HOURLY_LIMIT_PER_REPO = '1000';
  }, 90000);

  // -------------------------------------------------------------------------
  // Test 4: Incremental analysis on synchronize
  // -------------------------------------------------------------------------
  it('pr.synchronize triggers incremental analysis and records prior execution metadata', async () => {
    const repoFullName = `test-org/incremental-${crypto.randomBytes(4).toString('hex')}`;
    const [owner, repo] = repoFullName.split('/');
    const prNumber = 501;
    const headSha1 = crypto.randomBytes(20).toString('hex');
    const headSha2 = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    // --- First: full analysis on pr.opened ---
    mockGitHubAppAuth().persist();
    mockGetDiff({ owner, repo, prNumber, diff: SAMPLE_DIFF_LARGE });
    mockNoPullmintConfig({ owner, repo, headSha: headSha1 });
    mockGetCheckRuns({ owner, repo, headSha: headSha1 });
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);
    mockCreateReview({ owner, repo, prNumber });

    const w1 = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha: headSha1,
      baseSha,
      action: 'opened',
    });
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': w1.deliveryId,
        'x-hub-signature-256': w1.signature,
        'content-type': 'application/json',
      },
      payload: w1.payload,
    });

    const db = getDb();
    const [row1] = await db
      .select()
      .from(schema.executions)
      .where(
        and(
          eq(schema.executions.repoFullName, repoFullName),
          eq(schema.executions.prNumber, prNumber)
        )
      )
      .limit(1);

    await waitForExecutionStatus(row1.executionId, ['completed']);

    // --- Second: synchronize with same diff --- carry-forward all agents
    // Using same diff → 0% files changed → all agents carried forward → no LLM calls
    mockGetDiff({ owner, repo, prNumber, diff: SAMPLE_DIFF_LARGE });
    mockNoPullmintConfig({ owner, repo, headSha: headSha2 });
    mockGetCheckRuns({ owner, repo, headSha: headSha2 });
    // No LLM calls — all agents carried forward (diff identical → 0% changed files)
    mockCreateReview({ owner, repo, prNumber });

    const w2 = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha: headSha2,
      baseSha,
      action: 'synchronize',
    });
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': w2.deliveryId,
        'x-hub-signature-256': w2.signature,
        'content-type': 'application/json',
      },
      payload: w2.payload,
    });

    const [row2] = await db
      .select()
      .from(schema.executions)
      .where(
        and(
          eq(schema.executions.repoFullName, repoFullName),
          eq(schema.executions.prNumber, prNumber)
        )
      )
      .orderBy(desc(schema.executions.createdAt))
      .limit(1);

    expect(row2.executionId).not.toBe(row1.executionId); // new execution created

    const completed2 = await waitForExecutionStatus(row2.executionId, ['completed', 'failed']);
    expect(completed2.status).toBe('completed');

    // Assert incremental metadata recorded
    const metadata = (completed2.metadata as Record<string, unknown>) ?? {};
    expect(metadata.incremental).toBe(true);
    expect(metadata.priorExecutionId).toBe(row1.executionId);
    expect(Array.isArray(metadata.carriedForwardAgents)).toBe(true);
  }, 120000);
});
