import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { CheckpointRecordSchema } from '@pullmint/shared/schemas';
import type { ExecutionConfirmedEvent, ExecutionRolledBackEvent } from '@pullmint/shared/types';

const MIN_OBSERVATIONS = 10;
const ALPHA = 0.05;
const MAX_FACTOR = 2.0;
const MIN_FACTOR = 0.5;

const AnalysisCheckpointSchema = CheckpointRecordSchema.pick({ type: true, decision: true });

export async function processCalibrationJob(job: Job): Promise<void> {
  const isConfirmed = job.name === 'execution.confirmed';
  const detail = job.data as { executionId: string; repoFullName: string } & (
    | ExecutionConfirmedEvent
    | ExecutionRolledBackEvent
  );
  const { executionId, repoFullName } = detail;
  const db = getDb();

  // 1. Get execution to find the analysis checkpoint decision
  const [execution] = await db
    .select({ checkpoints: schema.executions.checkpoints })
    .from(schema.executions)
    .where(eq(schema.executions.executionId, executionId))
    .limit(1);

  if (!execution) return;

  const rawCheckpoints = (execution.checkpoints as unknown as unknown[]) ?? [];
  const checkpoints = rawCheckpoints
    .map((cp) => AnalysisCheckpointSchema.safeParse(cp))
    .filter((r) => r.success)
    .map((r) => r.data);
  const analysisCheckpoint = checkpoints.find((c) => c.type === 'analysis');
  const decision = analysisCheckpoint?.decision as 'approved' | 'held' | undefined;

  // 2. Get or create calibration record
  const calRecord = await getOrCreateCalibrationRecord(repoFullName);

  const observationsCount = calRecord?.observationsCount ?? 0;
  const oldFactor = calRecord?.calibrationFactor ?? 1.0;

  // 3. Classify outcome
  const isFalseNegative = decision === 'approved' && !isConfirmed; // approved but rolled back
  const isFalsePositive = decision === 'held' && isConfirmed; // held but confirmed fine

  // 4. Compute new calibration factor if threshold met and error detected
  let newFactor: number | undefined;
  if (observationsCount >= MIN_OBSERVATIONS) {
    if (isFalseNegative) {
      const target = Math.min(MAX_FACTOR, oldFactor + 0.15);
      newFactor = Math.min(MAX_FACTOR, oldFactor + ALPHA * (target - oldFactor));
    } else if (isFalsePositive) {
      const target = Math.max(MIN_FACTOR, oldFactor - 0.15);
      newFactor = Math.max(MIN_FACTOR, oldFactor + ALPHA * (target - oldFactor));
    }
  }

  // 5. Atomic counter increment + optional factor update in a single statement
  await db
    .update(schema.calibrations)
    .set({
      observationsCount: sql`observations_count + 1`,
      successCount: isConfirmed ? sql`success_count + 1` : schema.calibrations.successCount,
      rollbackCount: isConfirmed ? schema.calibrations.rollbackCount : sql`rollback_count + 1`,
      falseNegativeCount: isFalseNegative
        ? sql`false_negative_count + 1`
        : schema.calibrations.falseNegativeCount,
      falsePositiveCount: isFalsePositive
        ? sql`false_positive_count + 1`
        : schema.calibrations.falsePositiveCount,
      calibrationFactor:
        newFactor !== undefined ? newFactor : schema.calibrations.calibrationFactor,
      lastUpdatedAt: new Date().toISOString(),
      updatedAt: new Date(),
    })
    .where(eq(schema.calibrations.repoFullName, repoFullName));
}

async function getOrCreateCalibrationRecord(
  repoFullName: string
): Promise<typeof schema.calibrations.$inferSelect | undefined> {
  const db = getDb();

  // Try to insert initial record — onConflictDoNothing for concurrent safety
  await db
    .insert(schema.calibrations)
    .values({
      repoFullName,
      observationsCount: 0,
      successCount: 0,
      rollbackCount: 0,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      calibrationFactor: 1.0,
      lastUpdatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  const [record] = await db
    .select()
    .from(schema.calibrations)
    .where(eq(schema.calibrations.repoFullName, repoFullName))
    .limit(1);

  return record;
}
