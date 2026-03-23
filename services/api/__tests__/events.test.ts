import Fastify from 'fastify';
import { registerEventRoutes } from '../src/routes/events';

jest.mock('../src/sse', () => ({
  initSSE: jest.fn(),
  closeSSE: jest.fn().mockResolvedValue(undefined),
  addClient: jest.fn(),
}));

describe('Event Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DASHBOARD_AUTH_TOKEN = 'valid-token';
  });

  afterEach(() => {
    delete process.env.DASHBOARD_AUTH_TOKEN;
  });

  describe('GET /dashboard/events', () => {
    it('returns 401 when no token provided', async () => {
      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/events',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
      await app.close();
    });

    it('returns 401 when wrong token provided', async () => {
      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=wrong',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
      await app.close();
    });

    it('returns 401 when DASHBOARD_AUTH_TOKEN env var not set', async () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=any-token',
      });

      expect(response.statusCode).toBe(401);
      await app.close();
    });

    it('returns 429 when connection limit exceeded', async () => {
      const { addClient } = jest.requireMock('../src/sse') as {
        addClient: jest.Mock;
      };
      addClient.mockReturnValueOnce({ ok: false });

      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=valid-token',
      });

      expect(response.statusCode).toBe(429);
      expect(JSON.parse(response.body)).toEqual({ error: 'Too many SSE connections' });
      await app.close();
    });

    it('calls addClient with correct IP', async () => {
      const { addClient } = jest.requireMock('../src/sse') as {
        addClient: jest.Mock;
      };

      let capturedArgs: any[] = [];
      addClient.mockImplementation((...args: any[]) => {
        capturedArgs = args;
        const reply = args[0];
        // Immediately end response to avoid timeout
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.raw.end(':ok\n\n');
        return { ok: true };
      });

      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=valid-token',
        headers: { 'x-real-ip': '192.168.1.50' },
      });

      expect(addClient).toHaveBeenCalled();
      expect(capturedArgs[2]).toBe('192.168.1.50');
      await app.close();
    });

    it('passes repo filter to addClient', async () => {
      const { addClient } = jest.requireMock('../src/sse') as {
        addClient: jest.Mock;
      };

      let repoFilter = '';
      addClient.mockImplementation((...args: any[]) => {
        repoFilter = args[1];
        const reply = args[0];
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.raw.end(':ok\n\n');
        return { ok: true };
      });

      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=valid-token&repo=myorg/myrepo',
      });

      expect(repoFilter).toBe('myorg/myrepo');
      await app.close();
    });

    it('passes null repo filter when not specified', async () => {
      const { addClient } = jest.requireMock('../src/sse') as {
        addClient: jest.Mock;
      };

      let repoFilter = 'default';
      addClient.mockImplementation((...args: any[]) => {
        repoFilter = args[1];
        const reply = args[0];
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.raw.end(':ok\n\n');
        return { ok: true };
      });

      const app = Fastify({ logger: false });
      registerEventRoutes(app);

      await app.inject({
        method: 'GET',
        url: '/dashboard/events?token=valid-token',
      });

      expect(repoFilter).toBeNull();
      await app.close();
    });
  });
});
