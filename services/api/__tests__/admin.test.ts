import Fastify from 'fastify';
import { registerAdminRoutes } from '../src/routes/admin';

jest.mock('@bull-board/api', () => ({
  createBullBoard: jest.fn(),
}));

jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: jest.fn().mockImplementation((queue: unknown) => ({ queue })),
}));

jest.mock('@bull-board/fastify', () => ({
  FastifyAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    registerPlugin: jest.fn().mockReturnValue(() => undefined),
  })),
}));

jest.mock('@pullmint/shared/queue', () => ({
  getQueue: jest.fn((name: string) => ({ name })),
  QUEUE_NAMES: {
    ANALYSIS: 'analysis',
    AGENT: 'agent',
    SYNTHESIS: 'synthesis',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'DASHBOARD_AUTH_TOKEN') {
      return 'dashboard-token';
    }
    return 'test-value';
  }),
  getConfigOptional: jest.fn(),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  await registerAdminRoutes(app);
  app.get('/admin/ping', () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { getConfigOptional } = jest.requireMock('@pullmint/shared/config') as {
      getConfigOptional: jest.Mock;
    };
    getConfigOptional.mockReturnValue(undefined);
  });

  it('returns 401 when no auth header is provided', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/ping',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 when token is invalid', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('accepts ADMIN_AUTH_TOKEN when set', async () => {
    const { getConfigOptional } = jest.requireMock('@pullmint/shared/config') as {
      getConfigOptional: jest.Mock;
    };
    getConfigOptional.mockReturnValue('admin-token');

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    await app.close();
  });

  it('falls back to DASHBOARD_AUTH_TOKEN when ADMIN_AUTH_TOKEN is not set', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: 'Bearer dashboard-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    await app.close();
  });
});
