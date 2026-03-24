import type { FastifyInstance } from 'fastify';
import { addClient } from '../sse';

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/dashboard/events', async (request, reply) => {
    // Auth: accept Bearer token from query param (EventSource doesn't support custom headers)
    const token = (request.query as { token?: string }).token;
    const dashboardToken = process.env.DASHBOARD_AUTH_TOKEN;

    if (!dashboardToken || token !== dashboardToken) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Optional repo filter
    const repoFilter = (request.query as { repo?: string }).repo || null;

    // Concurrent connection limit per IP — must check BEFORE writing 200 headers
    const clientIp = (request.headers['x-real-ip'] as string) || request.ip;
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
