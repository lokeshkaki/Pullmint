// services/e2e/src/helpers/wait-for.ts
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';

export type ExecutionStatus =
  | 'pending'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'rate_limited'
  | 'cached';

/**
 * Polls the executions table until the row reaches one of `targetStatuses` or times out.
 * Returns the full execution row.
 */
export async function waitForExecutionStatus(
  executionId: string,
  targetStatuses: ExecutionStatus[],
  timeoutMs = 60000,
  pollIntervalMs = 500
): Promise<typeof schema.executions.$inferSelect> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.executionId, executionId))
      .limit(1);

    if (row && targetStatuses.includes(row.status as ExecutionStatus)) {
      return row;
    }

    await sleep(pollIntervalMs);
  }

  // Fetch final state for useful error message
  const db = getDb();
  const [finalRow] = await db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.executionId, executionId))
    .limit(1);

  throw new Error(
    `waitForExecutionStatus timed out after ${timeoutMs}ms for execution ${executionId}. ` +
      `Current status: ${finalRow?.status ?? 'row not found'}. ` +
      `Expected one of: ${targetStatuses.join(', ')}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the execution row exists in the DB (status may be anything).
 * Useful after POSTing a webhook before polling for specific status.
 */
export async function waitForExecutionCreated(
  executionId: string,
  timeoutMs = 10000,
  pollIntervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const db = getDb();
    const [row] = await db
      .select({ executionId: schema.executions.executionId })
      .from(schema.executions)
      .where(eq(schema.executions.executionId, executionId))
      .limit(1);

    if (row) return;
    await sleep(pollIntervalMs);
  }

  throw new Error(`waitForExecutionCreated timed out: execution ${executionId} never appeared`);
}
