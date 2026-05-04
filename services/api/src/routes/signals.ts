import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig } from '@pullmint/shared/config';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { eq, sql } from 'drizzle-orm';
import type { Signal, SignalType } from '@pullmint/shared/types';

const ACTIVE_STATUSES = new Set(['pending', 'analyzing', 'completed', 'deploying', 'monitoring']);

const VALID_SIGNAL_TYPES: ReadonlySet<SignalType> = new Set<SignalType>([
  'production.error_rate',
  'production.latency',
  'deployment.status',
  'ci.coverage',
  'ci.result',
  'time_of_day',
  'author_history',
  'simultaneous_deploy',
]);

const REQUIRED_FIELDS: (keyof Signal)[] = ['signalType', 'value', 'source', 'timestamp'];

function getSignalRateLimitMax(): number {
  const parsed = Number.parseInt(process.env.SIGNAL_INGESTION_RATE_LIMIT_MAX ?? '30', 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 30 : parsed;
}

function getSignalRateLimitTimeWindow(): string {
  return process.env.SIGNAL_INGESTION_RATE_LIMIT_WINDOW ?? '1 minute';
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function registerSignalRoutes(app: FastifyInstance): void {
  app.post(
    '/signals/:executionId',
    {
      config: {
        rateLimit: {
          max: getSignalRateLimitMax(),
          timeWindow: getSignalRateLimitTimeWindow(),
          keyGenerator: (request: FastifyRequest) => {
            const realIp = request.headers['x-real-ip'];
            return typeof realIp === 'string' && realIp.length > 0 ? realIp : request.ip;
          },
        },
      },
    },
    async (request, reply) => {
      const req = request as FastifyRequest & { rawBody?: string };
      try {
        const { executionId } = request.params as { executionId: string };
        if (!executionId) return reply.status(400).send({ message: 'Missing executionId' });

        // 1. HMAC auth
        const signature = request.headers['x-pullmint-signature'] as string | undefined;
        if (!signature) return reply.status(401).send({ message: 'Missing signature' });
        const body = req.rawBody ?? '';
        const secret = getConfig('SIGNAL_INGESTION_HMAC_SECRET');
        if (!verifySignature(body, signature, secret)) {
          return reply.status(401).send({ message: 'Invalid signature' });
        }

        // 2. Parse and validate body
        let signalData: Record<string, unknown>;
        try {
          signalData = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return reply.status(400).send({ message: 'Invalid JSON' });
        }
        const missing = REQUIRED_FIELDS.filter((f) => signalData[f] === undefined);
        if (missing.length > 0) {
          return reply.status(400).send({ message: `Missing fields: ${missing.join(', ')}` });
        }
        if (!VALID_SIGNAL_TYPES.has(signalData.signalType as SignalType)) {
          return reply.status(400).send({
            message: `Invalid signalType. Must be one of: ${[...VALID_SIGNAL_TYPES].join(', ')}`,
          });
        }
        const signal = signalData as unknown as Signal;

        // 3. Fetch execution
        const db = getDb();
        const rows = await db
          .select()
          .from(schema.executions)
          .where(eq(schema.executions.executionId, executionId))
          .limit(1);
        const execution = rows[0];
        if (!execution) return reply.status(404).send({ message: 'Execution not found' });
        if (!ACTIVE_STATUSES.has(execution.status)) {
          return reply
            .status(400)
            .send({ message: `Execution is in terminal state: ${execution.status}` });
        }

        addTraceAnnotations({ executionId });

        // 4. Idempotency check — key: `${signalType}:${timestamp}`
        const signalKey = `${signal.signalType}:${signal.timestamp}`;
        const existingMap = execution.signalsReceived as Record<string, unknown> | undefined;
        if (existingMap?.[signalKey]) {
          return reply.status(200).send({ message: 'Signal already recorded' });
        }

        // 5. Store signal — atomic JSONB update using COALESCE to handle absent map
        const signalEntry = { value: signal.value, source: signal.source, receivedAt: Date.now() };
        await db.execute(
          sql`UPDATE executions
            SET signals_received = jsonb_set(
              COALESCE(signals_received, '{}'::jsonb),
              ${[signalKey]},
              ${JSON.stringify(signalEntry)}::jsonb
            ),
            updated_at = NOW()
            WHERE execution_id = ${executionId}`
        );

        // 6. Publish event via BullMQ
        await addJob(QUEUE_NAMES.DEPLOYMENT_STATUS, 'signal.received', {
          executionId,
          signalKey,
          signal: signal,
        });

        return reply.status(200).send({ message: 'Signal recorded' });
      } catch (error) {
        console.error('Signal ingestion error:', error);
        return reply.status(500).send({ message: 'Internal server error' });
      }
    }
  );
}
