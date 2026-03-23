import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { CheckpointRecordSchema } from '@pullmint/shared/schemas';
import { resolveSignalWeights, DEFAULT_SIGNAL_WEIGHTS } from '@pullmint/shared/signal-weights';
import type {
  ExecutionConfirmedEvent,
  ExecutionRolledBackEvent,
  OutcomeLogEntry,
  Signal,
  SignalWeights,
} from '@pullmint/shared/types';

const MIN_OBSERVATIONS = 10;
const ALPHA = 0.05;
const GLOBAL_ALPHA = 0.02;
const MAX_FACTOR = 2.0;
const MIN_FACTOR = 0.5;
const MAX_OUTCOME_LOG_ENTRIES = 200;

const AnalysisCheckpointSchema = CheckpointRecordSchema.pick({
  type: true,
  decision: true,
  signals: true,
});

export async function processCalibrationJob(job: Job): Promise<void> {
  // Route signal recalibration jobs to dedicated processor
  if (job.name === 'signal.recalibration') {
    const { processSignalRecalibration } = await import('./signal-recalibration');
    await processSignalRecalibration();
    return;
  }

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

  const checkpointSignals: Signal[] = analysisCheckpoint?.signals ?? [];

  // Identify "present" signals: those whose threshold condition was met (delta > 0)
  const signalsPresentSet = new Set<string>();
  for (const signal of checkpointSignals) {
    if (isSignalThresholdMet(signal)) {
      signalsPresentSet.add(signal.signalType);
    }
  }
  const signalsPresent = Array.from(signalsPresentSet);

  // 2. Get or create calibration record
  const calRecord = await getOrCreateCalibrationRecord(db, repoFullName);

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

  // 5. Signal weight learning
  const rollback = !isConfirmed;
  const analysisDecision = decision ?? 'approved';
  let updatedRepoWeights: SignalWeights | undefined;
  let updatedGlobalWeights: SignalWeights | undefined;

  if (signalsPresent.length > 0) {
    // Resolve current weights (repo fallback chain)
    const currentWeights = await resolveSignalWeights(repoFullName, db);

    // Load current repo-specific weights (may be null)
    const repoWeights: SignalWeights = calRecord?.signalWeights
      ? { ...calRecord.signalWeights }
      : {};

    // Load global baseline
    const [globalRow] = await db
      .select({ weights: schema.signalWeightDefaults.weights })
      .from(schema.signalWeightDefaults)
      .where(eq(schema.signalWeightDefaults.id, 'global'))
      .limit(1);
    const globalWeights: SignalWeights = globalRow?.weights
      ? { ...globalRow.weights }
      : { ...DEFAULT_SIGNAL_WEIGHTS };

    // Update per-repo weights (alpha = 0.05)
    updatedRepoWeights = { ...repoWeights };
    for (const signal of signalsPresent) {
      const currentWeight = currentWeights[signal] ?? DEFAULT_SIGNAL_WEIGHTS[signal] ?? 0;
      const newWeight = computeEmaWeight(currentWeight, signal, rollback, analysisDecision, ALPHA);
      updatedRepoWeights[signal] = newWeight;
    }

    // Update global baseline weights (alpha = 0.02)
    updatedGlobalWeights = { ...globalWeights };
    for (const signal of signalsPresent) {
      const currentGlobalWeight = globalWeights[signal] ?? DEFAULT_SIGNAL_WEIGHTS[signal] ?? 0;
      const newWeight = computeEmaWeight(
        currentGlobalWeight,
        signal,
        rollback,
        analysisDecision,
        GLOBAL_ALPHA
      );
      updatedGlobalWeights[signal] = newWeight;
    }
  }

  // Build outcome log entry
  const outcomeEntry: OutcomeLogEntry = {
    signalsPresent,
    rollback,
    analysisDecision,
    timestamp: Date.now(),
  };

  // 6. Atomic update: calibration counters + signal weights + outcome log + global baseline
  await db.transaction(async (tx) => {
    const currentOutcomeLog = (calRecord?.outcomeLog as OutcomeLogEntry[] | undefined) ?? [];
    const newOutcomeLog = [...currentOutcomeLog, outcomeEntry].slice(-MAX_OUTCOME_LOG_ENTRIES);

    await tx
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
        signalWeights: updatedRepoWeights ?? schema.calibrations.signalWeights,
        outcomeLog: newOutcomeLog as unknown as OutcomeLogEntry[],
        lastUpdatedAt: new Date().toISOString(),
        updatedAt: new Date(),
      })
      .where(eq(schema.calibrations.repoFullName, repoFullName));

    if (updatedGlobalWeights) {
      await tx
        .insert(schema.signalWeightDefaults)
        .values({
          id: 'global',
          weights: updatedGlobalWeights,
          observationsCount: sql`1`,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.signalWeightDefaults.id,
          set: {
            weights: updatedGlobalWeights,
            observationsCount: sql`${schema.signalWeightDefaults.observationsCount} + 1`,
            updatedAt: new Date(),
          },
        });
    }
  });
}

async function getOrCreateCalibrationRecord(
  db: ReturnType<typeof getDb>,
  repoFullName: string
): Promise<typeof schema.calibrations.$inferSelect | undefined> {
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

function isSignalThresholdMet(signal: Signal): boolean {
  const { signalType, value } = signal;
  switch (signalType) {
    case 'ci.result':
      return value === false;
    case 'ci.coverage':
      return typeof value === 'number' && value < -10;
    case 'production.error_rate':
      return typeof value === 'number' && value > 10;
    case 'production.latency':
      return typeof value === 'number' && value > 20;
    case 'time_of_day':
      return typeof value === 'number' && isFridayAfternoon(value);
    case 'author_history':
      return typeof value === 'number' && value > 0.2;
    case 'simultaneous_deploy':
      return value === true;
    default:
      return false;
  }
}

function isFridayAfternoon(timestamp: number): boolean {
  const d = new Date(timestamp);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return (day === 5 && hour >= 12) || (day === 6 && hour < 6);
}

function computeEmaWeight(
  currentWeight: number,
  signal: string,
  rollback: boolean,
  analysisDecision: string,
  alpha: number
): number {
  let targetWeight: number;

  if (rollback) {
    targetWeight = currentWeight * 1.15;
  } else if (analysisDecision === 'held') {
    targetWeight = currentWeight * 0.85;
  } else {
    targetWeight = currentWeight;
  }

  const newWeight = currentWeight + alpha * (targetWeight - currentWeight);

  // Clamp to [0, 3 × hardcoded default]
  const hardcodedDefault = DEFAULT_SIGNAL_WEIGHTS[signal] ?? 20;
  const maxWeight = 3 * hardcodedDefault;
  return Math.max(0, Math.min(maxWeight, newWeight));
}
