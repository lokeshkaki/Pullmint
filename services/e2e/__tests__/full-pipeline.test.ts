// services/e2e/__tests__/full-pipeline.test.ts
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
import { buildWebhookPayload, SAMPLE_DIFF_LARGE } from '../src/helpers/fixtures';
import { waitForExecutionStatus } from '../src/helpers/wait-for';
import { getDb, schema } from '@pullmint/shared/db';
import { getObject } from '@pullmint/shared/storage';
import { eq } from 'drizzle-orm';

const describeE2E = process.env.RUN_E2E_TESTS === 'true' ? describe : describe.skip;

describeE2E('Full PR analysis pipeline', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    // Block all real outbound HTTP — tests must register nock interceptors explicitly
    nock.disableNetConnect();
    nock.enableNetConnect(/^(127\.0\.0\.1|::1)(:\d+)?$/); // allow localhost (DB, Redis, MinIO)

    // Start Fastify API
    app = Fastify({ logger: false });
    const { registerWebhookRoutes } = await import('../../api/src/routes/webhook');
    const { registerDashboardRoutes } = await import('../../api/src/routes/dashboard');
    const { registerHealthRoutes } = await import('../../api/src/routes/health');
    registerHealthRoutes(app);
    registerWebhookRoutes(app);
    registerDashboardRoutes(app);
    await app.ready();

    // Start BullMQ workers (analysis + integration groups)
    await startWorkers();
  }, 30000);

  afterAll(async () => {
    await stopWorkers();
    await app.close();
    nock.enableNetConnect();
    cleanupLLMMocks();
  });

  afterEach(() => {
    // Ensure all nock interceptors were consumed
    // (un-consumed interceptors indicate a mock was registered but the code path wasn't hit)
    nock.cleanAll();
  });

  it('PR opened webhook triggers full analysis pipeline and posts PR review', async () => {
    const owner = 'test-org';
    const repo = `repo-${crypto.randomBytes(4).toString('hex')}`;
    const repoFullName = `${owner}/${repo}`;
    const prNumber = 101;
    const headSha = crypto.randomBytes(20).toString('hex');
    const baseSha = crypto.randomBytes(20).toString('hex');

    // --- Set up nock interceptors ---

    // GitHub App token exchange (called when github-integration worker creates Octokit client)
    mockGitHubAppAuth().persist(); // persist because token might be fetched multiple times

    // Diff fetch (called by analysis dispatcher)
    mockGetDiff({ owner, repo, prNumber, diff: SAMPLE_DIFF_LARGE });

    // .pullmint.yml fetch → 404 → default config
    mockNoPullmintConfig({ owner, repo, headSha });

    // CI check-runs (called by checkpoint builder)
    mockGetCheckRuns({ owner, repo, headSha });

    // LLM: 4 agents + 1 synthesis summary
    mockLLMForAgents(['architecture', 'security', 'performance', 'style']);

    // PR review creation — capture the body for assertions
    let capturedReviewBody: Record<string, unknown> = {};
    mockCreateReview({
      owner,
      repo,
      prNumber,
      onCall: (body) => {
        capturedReviewBody = body;
      },
    });

    // --- Send webhook ---
    const { payload, signature, deliveryId } = buildWebhookPayload({
      repoFullName,
      prNumber,
      headSha,
      baseSha,
      action: 'opened',
    });

    const response = await app.inject({
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

    expect(response.statusCode).toBe(202);

    // --- Extract executionId from DB (webhook handler inserts synchronously) ---
    const db = getDb();
    const [executionRow] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.repoFullName, repoFullName))
      .orderBy(schema.executions.createdAt)
      .limit(1);

    expect(executionRow).toBeDefined();
    const { executionId } = executionRow;

    // --- Wait for pipeline completion ---
    const completed = await waitForExecutionStatus(executionId, ['completed', 'failed']);
    expect(completed.status).toBe('completed');

    // --- Assert execution record ---
    expect(completed.riskScore).toBeGreaterThanOrEqual(0);
    expect(completed.riskScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(completed.findings)).toBe(true);
    expect((completed.findings as unknown[]).length).toBeGreaterThan(0);

    // --- Assert MinIO objects ---
    const bucket = process.env.ANALYSIS_RESULTS_BUCKET!;

    const diffContent = await getObject(bucket, `diffs/${executionId}.diff`);
    expect(diffContent).toContain('diff --git');

    const analysisJson = await getObject(bucket, `executions/${executionId}/analysis.json`);
    const analysis = JSON.parse(analysisJson) as Record<string, unknown>;
    expect(analysis).toHaveProperty('findings');
    expect(analysis).toHaveProperty('riskScore');

    // --- Assert PR review was posted ---
    expect(capturedReviewBody).toHaveProperty('event', 'COMMENT');
    expect(typeof capturedReviewBody.body).toBe('string');
    expect((capturedReviewBody.body as string).length).toBeGreaterThan(0);

    // --- Assert inline comments (if any) have valid structure ---
    const comments = (capturedReviewBody.comments ?? []) as Array<Record<string, unknown>>;
    for (const comment of comments) {
      expect(typeof comment.path).toBe('string');
      expect(typeof comment.line).toBe('number');
      expect(comment.side).toBe('RIGHT');
      expect(typeof comment.body).toBe('string');
    }
  }, 90000);
});
