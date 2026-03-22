import Fastify from 'fastify';
import { registerHealthRoutes } from '../src/routes/health';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn().mockResolvedValue(undefined),
  })),
  schema: {},
}));

jest.mock('@pullmint/shared/queue', () => ({
  getQueue: jest.fn(() => ({
    client: Promise.resolve({}),
  })),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app);
  return app;
}

describe('Health Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when all checks pass', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as {
        getDb: jest.Mock;
      };
      getDb.mockReturnValue({
        execute: jest.fn().mockResolvedValue(undefined),
      });

      const { getQueue } = jest.requireMock('../../shared/queue') as {
        getQueue: jest.Mock;
      };
      getQueue.mockReturnValue({ client: Promise.resolve({}) });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('ready');
      expect(body.checks.postgres).toBe('ok');
    });

    it('returns 503 when postgres check fails', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as {
        getDb: jest.Mock;
      };
      getDb.mockReturnValue({
        execute: jest.fn().mockRejectedValue(new Error('connection refused')),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body) as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('not ready');
      expect(body.checks.postgres).toBe('error');
    });

    it('returns 503 when redis check fails', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as {
        getDb: jest.Mock;
      };
      getDb.mockReturnValue({
        execute: jest.fn().mockResolvedValue(undefined),
      });

      const { getQueue } = jest.requireMock('../../shared/queue') as {
        getQueue: jest.Mock;
      };
      getQueue.mockReturnValue({ client: Promise.reject(new Error('redis down')) });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body) as { status: string; checks: Record<string, string> };
      expect(body.status).toBe('not ready');
      expect(body.checks.redis).toBe('error');
    });
  });
});
