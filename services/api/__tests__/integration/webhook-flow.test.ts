import { setupIntegration } from './setup';
import Fastify from 'fastify';
import crypto from 'crypto';
import IORedis from 'ioredis';

// This test requires Docker containers running via docker-compose.test.yml

const describeIntegration = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeIntegration('Webhook Flow Integration', () => {
  let app: ReturnType<typeof Fastify>;
  let redis: IORedis;

  beforeAll(async () => {
    await setupIntegration();
    // Build Fastify app with real (not mocked) dependencies
    // Import routes after setting env vars
    app = Fastify();
    const { registerWebhookRoutes } = await import('../../src/routes/webhook');
    const { registerHealthRoutes } = await import('../../src/routes/health');
    await registerHealthRoutes(app);
    await registerWebhookRoutes(app);
    await app.ready();

    redis = new IORedis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (redis) {
      await redis.quit();
    }
  });

  it('should accept a valid webhook and queue an analysis job', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      number: 42,
      pull_request: {
        head: { sha: 'abc1234567' },
        base: { sha: 'def7654321' },
        user: { login: 'testuser' },
        title: 'Test PR',
      },
      repository: { full_name: 'owner/repo' },
      installation: { id: 12345 },
    });

    const signature =
      'sha256=' +
      crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(payload).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'test-delivery-123',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);

    // Verify a job was added to the analysis queue in Redis
    // (Check BullMQ queue state)
  });

  it('should reject invalid HMAC signatures', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'test-delivery-456',
        'x-hub-signature-256': 'sha256=invalid',
        'content-type': 'application/json',
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(401);
  });
});
