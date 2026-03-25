import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';

const CHANNEL = 'pullmint:execution-updates';

let publisherConnection: IORedis | null = null;

function getPublisher(): IORedis {
  if (!publisherConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    publisherConnection = new IORedis(redisUrl);
  }
  return publisherConnection;
}

export interface ExecutionUpdateEvent {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  status: string;
  riskScore: number | null;
  updatedAt: number;
}

/**
 * Updates an execution record in the database AND publishes a real-time event to Redis.
 * Use this for unconditional status writes (simple `eq(executionId)` where clause).
 *
 * For conditional writes (e.g., `where(eq(status, 'monitoring'))`), perform the DB update
 * yourself, check `.returning()`, then call `publishEvent()` if rows were affected.
 */
export async function publishExecutionUpdate(
  executionId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const db = getDb();

  // Single atomic UPDATE ... RETURNING avoids a stale read between queries.
  const [row] = await db
    .update(schema.executions)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(schema.executions.executionId, executionId))
    .returning({
      executionId: schema.executions.executionId,
      repoFullName: schema.executions.repoFullName,
      prNumber: schema.executions.prNumber,
      status: schema.executions.status,
      riskScore: schema.executions.riskScore,
    });

  if (!row) return;

  const event: ExecutionUpdateEvent = {
    executionId: row.executionId,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    status: row.status,
    riskScore: row.riskScore,
    updatedAt: Date.now(),
  };

  try {
    await getPublisher().publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    // Best-effort: DB update already succeeded, don't fail the processor
    console.error('Failed to publish execution update event:', err);
  }
}

/**
 * Publishes a pre-built event to Redis without performing a DB update.
 * Use this after conditional DB writes that use `.returning()` to confirm rows were affected.
 */
export async function publishEvent(event: ExecutionUpdateEvent): Promise<void> {
  try {
    await getPublisher().publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error('Failed to publish execution event:', err);
  }
}

export async function closePublisher(): Promise<void> {
  if (publisherConnection) {
    await publisherConnection.quit();
    publisherConnection = null;
  }
}
