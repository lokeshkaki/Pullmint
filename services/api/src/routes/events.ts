import type { FastifyInstance } from 'fastify';
import { getConfigOptional } from '@pullmint/shared/config';
import { timingSafeTokenCompare } from '../auth';
import { addClient, checkSSERateLimit } from '../sse';

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/dashboard/events', async (request, reply) => {
    const query = request.query as { token?: string; repo?: string };

    // EventSource cannot set Authorization headers, so this endpoint currently accepts
    // the token via query string. A future iteration should prefer short-lived tokens.
    const clientIp = (request.headers['x-real-ip'] as string) || request.ip;
    if (!checkSSERateLimit(clientIp)) {
      return reply.code(429).send({ error: 'Too many SSE connection attempts' });
    }

    const dashboardToken = getConfigOptional('DASHBOARD_AUTH_TOKEN');
    const token = query.token;

    if (!dashboardToken || !token || !timingSafeTokenCompare(token, dashboardToken)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Optional repo filter
    const repoFilter = query.repo || null;

    // Concurrent connection limit per IP — must check BEFORE writing 200 headers
    const { ok } = addClient(reply, repoFilter, clientIp);
    if (!ok) {
      return reply.code(429).send({ error: 'Too many SSE connections' });
    }

    // Set SSE headers (after connection limit check passes)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial keepalive
    reply.raw.write(':ok\n\n');

    // Keep connection open — Fastify will not auto-close because we've taken over reply.raw
    // Cleanup handled by sse.ts on client disconnect
  });
}
