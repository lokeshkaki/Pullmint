import IORedis from 'ioredis';
import type { FastifyReply } from 'fastify';

const CHANNEL = 'pullmint:execution-updates';

interface SSEClient {
  reply: FastifyReply;
  repoFilter: string | null;
  clientIp: string;
}

let subscriber: IORedis | null = null;
const clients = new Set<SSEClient>();

const MAX_CLIENTS_PER_IP = 5;

export function initSSE(): void {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  subscriber = new IORedis(redisUrl);

  subscriber.subscribe(CHANNEL).catch((err) => {
    console.error('Failed to subscribe to execution updates channel:', err);
  });

  subscriber.on('message', (_channel: string, message: string) => {
    let event: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      event = JSON.parse(message) as Record<string, unknown>;
    } catch {
      console.error('Failed to parse SSE message from Redis:', message);
      return;
    }

    const eventId = String(event.updatedAt);

    for (const client of clients) {
      // Apply repo filter if set
      if (client.repoFilter && event.repoFullName !== client.repoFilter) {
        continue;
      }

      try {
        client.reply.raw.write(`id: ${eventId}\ndata: ${message}\n\n`);
      } catch {
        // Client disconnected — will be cleaned up by close handler
        clients.delete(client);
      }
    }
  });

  subscriber.on('error', (err) => {
    console.error('SSE Redis subscriber error:', err);
  });
}

export function addClient(
  reply: FastifyReply,
  repoFilter: string | null,
  clientIp: string
): { ok: boolean } {
  // Enforce concurrent connection limit per IP
  let ipCount = 0;
  for (const c of clients) {
    if (c.clientIp === clientIp) ipCount++;
  }
  if (ipCount >= MAX_CLIENTS_PER_IP) {
    return { ok: false };
  }

  const client: SSEClient = { reply, repoFilter, clientIp };
  clients.add(client);

  reply.raw.on('close', () => {
    clients.delete(client);
  });

  return { ok: true };
}

export function getClientCount(): number {
  return clients.size;
}

export async function closeSSE(): Promise<void> {
  for (const client of clients) {
    try {
      client.reply.raw.end();
    } catch {
      // already closed
    }
  }
  clients.clear();

  if (subscriber) {
    await subscriber.unsubscribe(CHANNEL);
    await subscriber.quit();
    subscriber = null;
  }
}
