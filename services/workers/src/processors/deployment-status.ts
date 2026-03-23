import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfigOptional } from '@pullmint/shared/config';
import { evaluateRisk } from '@pullmint/shared/risk-evaluator';
import { resolveSignalWeights } from '@pullmint/shared/signal-weights';
import { publishExecutionUpdate, publishEvent } from '@pullmint/shared/execution-events';
import { CheckpointRecordSchema } from '@pullmint/shared/schemas';
import type { ExecutionUpdateEvent } from '@pullmint/shared/execution-events';
import type {
  Signal,
  CheckpointRecord,
  DeploymentRollbackEvent,
  ExecutionConfirmedEvent,
} from '@pullmint/shared/types';

const ROLLBACK_THRESHOLD = parseInt(getConfigOptional('ROLLBACK_RISK_THRESHOLD') ?? '50', 10);
const LOW_CONFIDENCE_THRESHOLD = 0.3;
const T5_MS = 5 * 60 * 1000;
const T30_MS = 30 * 60 * 1000;
const MAX_BATCH = 20;

const CheckpointTypeSchema = CheckpointRecordSchema.pick({ type: true });

export async function processDeploymentStatusJob(): Promise<void> {
  const now = Date.now();
  const db = getDb();

  // Find executions in 'monitoring' state deployed more than T5 ago
  const cutoff5 = new Date(now - T5_MS).toISOString();
  const executions = await db
    .select()
    .from(schema.executions)
    .where(
      and(
        eq(schema.executions.status, 'monitoring'),
        lte(schema.executions.deploymentStartedAt, cutoff5)
      )
    )
    .limit(MAX_BATCH);

  let failedCount = 0;

  for (const execution of executions) {
    try {
      await evaluateCheckpoint(execution as unknown as Record<string, unknown>, now);
    } catch (err) {
      failedCount += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        JSON.stringify({
          error: 'checkpoint_evaluation_failed',
          executionId: execution.executionId,
          message: error.message,
          stack: error.stack,
        })
      );
    }
  }

  if (failedCount > 0) {
    console.error(
      JSON.stringify({
        error: 'batch_partial_failure',
        failedCount,
        totalCount: executions.length,
      })
    );
  }
}

async function evaluateCheckpoint(execution: Record<string, unknown>, now: number): Promise<void> {
  const deployedAtStr = execution.deploymentStartedAt as string | undefined;
  if (!deployedAtStr) return;

  const deployedAt = new Date(deployedAtStr).getTime();
  const elapsedMs = now - deployedAt;
  const isPastT30 = elapsedMs >= T30_MS;
  const checkpointType: 'post-deploy-5' | 'post-deploy-30' = isPastT30
    ? 'post-deploy-30'
    : 'post-deploy-5';

  // Idempotency: skip if this checkpoint type already exists
  const rawCheckpoints = (execution.checkpoints as unknown[]) ?? [];
  const existing = rawCheckpoints
    .map((cp) => CheckpointTypeSchema.safeParse(cp))
    .filter((r) => r.success)
    .map((r) => r.data);
  if (existing.some((c) => c.type === checkpointType)) return;

  // Build signals from signalsReceived map
  const signalsMap =
    (execution.signalsReceived as Record<string, { value: number | boolean; source: string }>) ??
    {};
  const signals: Signal[] = Object.entries(signalsMap).map(([key, val]) => {
    const colonIdx = key.lastIndexOf(':');
    const signalType = key.substring(0, colonIdx);
    const timestamp = Number(key.substring(colonIdx + 1));
    return {
      signalType: signalType as Signal['signalType'],
      value: val.value,
      source: val.source,
      timestamp,
    };
  });

  // calibrationApplied stored in metadata jsonb
  const metadata = (execution.metadata as Record<string, unknown>) ?? {};
  const calibrationFactor = (metadata.calibrationApplied as number) ?? 1.0;
  const blastRadiusMultiplier =
    (execution.repoContext as { blastRadiusMultiplier?: number })?.blastRadiusMultiplier ?? 1.0;
  const llmBaseScore = (execution.riskScore as number) ?? 50;

  const db = getDb();
  const signalWeights = await resolveSignalWeights(execution.repoFullName as string, db);

  const evaluation = evaluateRisk({
    llmBaseScore,
    signals,
    calibrationFactor,
    blastRadiusMultiplier,
    signalWeights,
  });

  const checkpoint: CheckpointRecord = {
    type: checkpointType,
    score: evaluation.score,
    confidence: evaluation.confidence,
    missingSignals: evaluation.missingSignals,
    signals,
    decision: evaluation.score >= ROLLBACK_THRESHOLD ? 'rollback' : 'approved',
    reason: evaluation.reason,
    evaluatedAt: now,
  };

  // T+5 low confidence: defer, no action yet
  if (!isPastT30 && evaluation.confidence < LOW_CONFIDENCE_THRESHOLD) {
    checkpoint.decision = 'approved';
    await writeCheckpoint(execution.executionId as string, checkpoint);
    return;
  }

  // T+30 low confidence: confirm with flag
  if (isPastT30 && evaluation.confidence < LOW_CONFIDENCE_THRESHOLD) {
    checkpoint.decision = 'approved';
    checkpoint.confirmedWithLowConfidence = true;
    await writeCheckpoint(execution.executionId as string, checkpoint);
    await confirmExecution(execution, evaluation.score, true, now);
    return;
  }

  await writeCheckpoint(execution.executionId as string, checkpoint);

  if (evaluation.score >= ROLLBACK_THRESHOLD) {
    await triggerRollback(execution, evaluation, checkpointType, now);
  } else if (isPastT30) {
    await confirmExecution(execution, evaluation.score, false, now);
  }
}

async function writeCheckpoint(executionId: string, checkpoint: CheckpointRecord): Promise<void> {
  const db = getDb();
  await db
    .update(schema.executions)
    .set({
      checkpoints:
        sql`COALESCE(checkpoints, '[]'::jsonb) || ${JSON.stringify([checkpoint])}::jsonb` as unknown as Record<
          string,
          unknown
        >,
      updatedAt: new Date(),
    })
    .where(eq(schema.executions.executionId, executionId));
}

async function triggerRollback(
  execution: Record<string, unknown>,
  evaluation: ReturnType<typeof evaluateRisk>,
  checkpointType: 'post-deploy-5' | 'post-deploy-30',
  now: number
): Promise<void> {
  const executionId = execution.executionId as string;
  const payload: DeploymentRollbackEvent = {
    executionId,
    repoFullName: execution.repoFullName as string,
    prNumber: execution.prNumber as number,
    reason: evaluation.reason,
    triggeredAt: now,
    checkpointType,
    riskScoreAtTrigger: evaluation.score,
  };

  await addJob(
    QUEUE_NAMES.DEPLOYMENT,
    'deployment.rollback',
    payload as unknown as Record<string, unknown>
  );

  // Write rolled-back status — conditional to avoid overwriting a more advanced state
  const db = getDb();
  const result = await db
    .update(schema.executions)
    .set({
      status: 'rolled-back',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.executions.executionId, executionId),
        eq(schema.executions.status, 'monitoring')
      )
    )
    .returning({ executionId: schema.executions.executionId });

  if (result.length === 0) {
    console.warn(
      `[deployment-status] Status already advanced past monitoring for ${executionId} — skipping rollback status write`
    );
    return;
  }

  const event: ExecutionUpdateEvent = {
    executionId,
    repoFullName: execution.repoFullName as string,
    prNumber: execution.prNumber as number,
    status: 'rolled-back',
    riskScore: (execution.riskScore as number) ?? null,
    updatedAt: Date.now(),
  };
  await publishEvent(event);
}

async function confirmExecution(
  execution: Record<string, unknown>,
  finalScore: number,
  lowConfidence: boolean,
  now: number
): Promise<void> {
  const executionId = execution.executionId as string;

  await publishExecutionUpdate(executionId, { status: 'confirmed' });

  const payload: ExecutionConfirmedEvent = {
    executionId,
    repoFullName: execution.repoFullName as string,
    prNumber: execution.prNumber as number,
    confirmedWithLowConfidence: lowConfidence,
    finalRiskScore: finalScore,
    confirmedAt: now,
  };

  await addJob(
    QUEUE_NAMES.CALIBRATION,
    'execution.confirmed',
    payload as unknown as Record<string, unknown>
  );
}
