import Fastify from 'fastify';
import { registerDashboardRoutes } from '../src/routes/dashboard';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: { notificationChannels: {}, executions: {} },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn(),
  QUEUE_NAMES: {},
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn().mockReturnValue('test-token'),
  getConfigOptional: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/notifications', () => ({
  sendNotification: jest.fn().mockResolvedValue(undefined),
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
}));

import { getDb } from '@pullmint/shared/db';
const { sendNotification, validateWebhookUrl } = jest.requireMock('@pullmint/shared/notifications') as {
  sendNotification: jest.Mock;
  validateWebhookUrl: jest.Mock;
};

const AUTH = { Authorization: 'Bearer test-token' };

function buildMockDb(returnValue: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue(returnValue),
    limit: jest.fn().mockResolvedValue(Array.isArray(returnValue) ? returnValue : [returnValue]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([returnValue]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  registerDashboardRoutes(app);
  await app.ready();
  return app;
}

describe('GET /dashboard/notifications', () => {
  it('returns 401 without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/notifications' });
    expect(res.statusCode).toBe(401);
  });

  it('returns channels list', async () => {
    const channels = [
      { id: 1, name: 'Slack', channelType: 'slack', events: ['analysis.completed'] },
    ];
    (getDb as jest.Mock).mockReturnValue(buildMockDb(channels));

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/notifications',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels).toHaveLength(1);
  });
});

describe('POST /dashboard/notifications', () => {
  beforeEach(() => {
    validateWebhookUrl.mockResolvedValue({ valid: true });
  });

  it('returns 400 for invalid payload (missing channelType)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      payload: { name: 'Test', webhookUrl: 'https://example.com', events: ['analysis.completed'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid webhook URL', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      payload: {
        name: 'Test',
        channelType: 'slack',
        webhookUrl: 'not-a-url',
        events: ['analysis.completed'],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a channel and returns 201', async () => {
    const created = { id: 1, name: 'Slack', channelType: 'slack' };
    (getDb as jest.Mock).mockReturnValue(buildMockDb(created));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      payload: {
        name: 'Slack',
        channelType: 'slack',
        webhookUrl: 'https://hooks.slack.com/test',
        events: ['analysis.completed'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).channel.id).toBe(1);
  });
});

describe('PUT /dashboard/notifications/:id', () => {
  it('returns 400 for invalid channel id', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/dashboard/notifications/not-a-number',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when channel not found', async () => {
    const db = buildMockDb(null);
    db.returning = jest.fn().mockResolvedValue([]);
    (getDb as jest.Mock).mockReturnValue(db);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/dashboard/notifications/999',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /dashboard/notifications/:id', () => {
  it('returns 400 for invalid channel id', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/notifications/not-a-number',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when channel is missing', async () => {
    const db = buildMockDb(null);
    db.returning = jest.fn().mockResolvedValue([]);
    (getDb as jest.Mock).mockReturnValue(db);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/notifications/999',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 204 on success', async () => {
    const db = buildMockDb({ id: 1 });
    (getDb as jest.Mock).mockReturnValue(db);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/dashboard/notifications/1',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('POST /dashboard/notifications/:id/test', () => {
  it('returns 400 for invalid channel id', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications/not-a-number/test',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when channel does not exist', async () => {
    const db = buildMockDb(null);
    db.limit = jest.fn().mockResolvedValue([]);
    (getDb as jest.Mock).mockReturnValue(db);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications/321/test',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('sends test notification and returns ok', async () => {
    const channel = {
      id: 1,
      name: 'Test',
      channelType: 'webhook',
      webhookUrl: 'https://example.com',
      repoFilter: null,
      events: ['analysis.completed'],
      minRiskScore: null,
      enabled: true,
      secret: null,
    };
    const db = buildMockDb(channel);
    db.limit = jest.fn().mockResolvedValue([channel]);
    (getDb as jest.Mock).mockReturnValue(db);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/notifications/1/test',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
