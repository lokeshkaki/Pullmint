import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@pullmint/shared/config';
import { timingSafeTokenCompare } from '../auth';

async function authenticateDashboardRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }

  let expected: string;
  try {
    expected = getConfig('DASHBOARD_AUTH_TOKEN');
  } catch {
    console.error('DASHBOARD_AUTH_TOKEN not configured; denying all requests');
    await reply.status(503).send({ error: 'Service unavailable: authentication not configured' });
    return;
  }

  if (!timingSafeTokenCompare(authHeader.slice(7), expected)) {
    await reply.status(401).send({ error: 'Unauthorized' });
  }
}

export function registerDashboardAuth(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/dashboard/') || request.url === '/dashboard') {
      await authenticateDashboardRequest(request, reply);
    }
  });
}
