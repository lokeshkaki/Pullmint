import { FastifyInstance } from 'fastify';
import { getDb } from '@pullmint/shared/db';
import { sql } from 'drizzle-orm';
import { getQueue } from '@pullmint/shared/queue';

export function registerHealthRoutes(app: FastifyInstance): void {
  // Liveness probe
  app.get('/health', () => {
    return { status: 'ok' };
  });

  // Readiness probe (checks Postgres and Redis connectivity)
  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};

    // Check Postgres
    try {
      const db = getDb();
      await db.execute(sql`SELECT 1`);
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'error';
    }

    // Check Redis (via queue module)
    try {
      const queue = getQueue('health-check');
      await queue.client;
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.status(allOk ? 200 : 503).send({ status: allOk ? 'ready' : 'not ready', checks });
  });
}
