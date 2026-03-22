import Fastify from 'fastify';
import * as crypto from 'crypto';
import { registerSignalRoutes } from '../src/routes/signals';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {
      executionId: 'executionId',
      status: 'status',
    },
  },
}));

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: { DEPLOYMENT_STATUS: 'deployment-status' },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'SIGNAL_INGESTION_HMAC_SECRET') return 'test-hmac-secret';
    return 'test-value';
  }),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

const HMAC_SECRET = 'test-hmac-secret';

function signBody(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
}

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as unknown as Record<string, string>).rawBody = body;
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  registerSignalRoutes(app);
  return app;
}

const TERMINAL_STATUSES = ['failed', 'confirmed'];
const ACTIVE_STATUSES = ['pending', 'analyzing'];

describe('Signal Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /signals/:executionId', () => {
    const executionId = 'exec-123';
    const validPayload = {
      signalType: 'ci.result',
      value: 'passed',
      source: 'github-actions',
      timestamp: Date.now(),
    };

    it('returns 401 when X-Signal-Signature header is missing', async () => {
      const body = JSON.stringify(validPayload);
      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when signature is invalid', async () => {
      const body = JSON.stringify(validPayload);
      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: {
          'content-type': 'application/json',
          'x-pullmint-signature': 'bad-signature',
        },
        body,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when required fields are missing', async () => {
      const incompletePayload = { signalType: 'ci.result' }; // missing value, source, timestamp
      const body = JSON.stringify(incompletePayload);
      const sig = signBody(body);

      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: {
          'content-type': 'application/json',
          'x-pullmint-signature': sig,
        },
        body,
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when signalType is invalid', async () => {
      // Include ALL required fields so the signalType check branch is reached
      const badPayload = {
        signalType: 'invalid.type',
        value: 'ok',
        source: 'test',
        timestamp: Date.now(),
      };
      const body = JSON.stringify(badPayload);
      const sig = signBody(body);

      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: {
          'content-type': 'application/json',
          'x-pullmint-signature': sig,
        },
        body,
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when execution is not found', async () => {
      const body = JSON.stringify(validPayload);
      const sig = signBody(body);

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
        url: `/signals/${executionId}`,
        headers: {
          'content-type': 'application/json',
          'x-pullmint-signature': sig,
        },
        body,
      });
      expect(response.statusCode).toBe(404);
    });

    it.each(TERMINAL_STATUSES)(
      'returns 400 when execution is already in terminal status "%s"',
      async (status) => {
        const body = JSON.stringify(validPayload);
        const sig = signBody(body);

        const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
        getDb.mockReturnValue({
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ executionId, status }]),
              }),
            }),
          }),
        });

        const response = await app.inject({
          method: 'POST',
          url: `/signals/${executionId}`,
          headers: {
            'content-type': 'application/json',
            'x-pullmint-signature': sig,
          },
          body,
        });
        expect(response.statusCode).toBe(400);
      }
    );

    it.each(ACTIVE_STATUSES)(
      'returns 200 and records signal for active status "%s"',
      async (status) => {
        const body = JSON.stringify(validPayload);
        const sig = signBody(body);

        const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
        getDb.mockReturnValue({
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ executionId, status }]),
              }),
            }),
          }),
          execute: jest.fn().mockResolvedValue(undefined),
        });

        const response = await app.inject({
          method: 'POST',
          url: `/signals/${executionId}`,
          headers: {
            'content-type': 'application/json',
            'x-pullmint-signature': sig,
          },
          body,
        });
        expect(response.statusCode).toBe(200);
        const responseBody = JSON.parse(response.body) as { message: string };
        expect(responseBody.message).toBe('Signal recorded');
      }
    );

    it('dispatches a job after recording a valid signal', async () => {
      const body = JSON.stringify(validPayload);
      const sig = signBody(body);

      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ executionId, status: 'pending' }]),
            }),
          }),
        }),
        execute: jest.fn().mockResolvedValue(undefined),
      });

      await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: {
          'content-type': 'application/json',
          'x-pullmint-signature': sig,
        },
        body,
      });

      const { addJob } = jest.requireMock('../../shared/queue') as { addJob: jest.Mock };
      expect(addJob).toHaveBeenCalledTimes(1);
      expect(addJob).toHaveBeenCalledWith(
        expect.any(String),
        'signal.received',
        expect.objectContaining({ executionId })
      );
    });

    it('returns 200 for signal already recorded (idempotency)', async () => {
      const ts = 1234567890;
      const idempotentPayload = {
        signalType: 'ci.result',
        value: 'passed',
        source: 'github-actions',
        timestamp: ts,
      };
      const body = JSON.stringify(idempotentPayload);
      const sig = signBody(body);

      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                {
                  executionId,
                  status: 'pending',
                  signalsReceived: { [`ci.result:${ts}`]: { value: 'passed' } },
                },
              ]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: { 'content-type': 'application/json', 'x-pullmint-signature': sig },
        body,
      });
      expect(response.statusCode).toBe(200);
      const responseBody = JSON.parse(response.body) as { message: string };
      expect(responseBody.message).toBe('Signal already recorded');
    });

    it('returns 500 when db throws an error', async () => {
      const body = JSON.stringify(validPayload);
      const sig = signBody(body);

      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockRejectedValue(new Error('DB connection failed')),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/signals/${executionId}`,
        headers: { 'content-type': 'application/json', 'x-pullmint-signature': sig },
        body,
      });
      expect(response.statusCode).toBe(500);
    });
  });
});
