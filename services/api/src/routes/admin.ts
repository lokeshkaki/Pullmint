import { FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { getQueue, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig, getConfigOptional } from '@pullmint/shared/config';
import { timingSafeTokenCompare } from '../auth';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Auth check for admin routes
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/admin/')) {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const token = authHeader.slice(7);
      const expected = getConfigOptional('ADMIN_AUTH_TOKEN') ?? getConfig('DASHBOARD_AUTH_TOKEN');
      if (!timingSafeTokenCompare(token, expected)) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }
  });

  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: Object.values(QUEUE_NAMES).map((name) => new BullMQAdapter(getQueue(name))),
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), {
    prefix: '/admin/queues',
  });
}
