import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { evaluateRisk } from '../shared/risk-evaluator';
import { CheckpointRecordSchema } from '../shared/schemas';
import type {
  Signal,
  CheckpointRecord,
  DeploymentRollbackEvent,
  ExecutionConfirmedEvent,
} from '../shared/types';

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const ROLLBACK_THRESHOLD = parseInt(process.env.ROLLBACK_RISK_THRESHOLD || '50', 10);
const LOW_CONFIDENCE_THRESHOLD = 0.3;
const T5_MS = 5 * 60 * 1000;
const T30_MS = 30 * 60 * 1000;
const MAX_BATCH = 20;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});
const CheckpointTypeSchema = CheckpointRecordSchema.pick({ type: true });

export const handler = async (): Promise<void> => {
  const now = Date.now();

  const { Items: executions = [] } = await ddb.send(
    new QueryCommand({
      TableName: EXECUTIONS_TABLE_NAME,
      IndexName: 'StatusDeployedAtIndex',
      KeyConditionExpression: '#status = :status AND deploymentStartedAt <= :cutoff',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'monitoring',
        ':cutoff': now - T5_MS,
      },
      Limit: MAX_BATCH,
    })
  );

  let failedCount = 0;

  for (const execution of executions) {
    try {
      await evaluateCheckpoint(execution as Record<string, unknown>, now);
    } catch (err) {
      failedCount += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      const executionId =
        typeof execution.executionId === 'string' ? execution.executionId : 'unknown-execution-id';
      console.error(
        JSON.stringify({
          error: 'checkpoint_evaluation_failed',
          executionId,
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
};

async function evaluateCheckpoint(execution: Record<string, unknown>, now: number): Promise<void> {
  const deployedAt = execution.deploymentStartedAt as number;
  const elapsedMs = now - deployedAt;
  const isPastT30 = elapsedMs >= T30_MS;
  const checkpointType = isPastT30 ? 'post-deploy-30' : 'post-deploy-5';

  // Idempotency: skip if this checkpoint type already exists
  const rawCheckpoints = (execution.checkpoints as unknown[]) ?? [];
  const existing = rawCheckpoints
    .map((checkpoint) => CheckpointTypeSchema.safeParse(checkpoint))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
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

  const calibrationFactor = (execution.calibrationApplied as number) ?? 1.0;
  const blastRadiusMultiplier =
    (execution.repoContext as { blastRadiusMultiplier?: number })?.blastRadiusMultiplier ?? 1.0;
  const llmBaseScore = (execution.riskScore as number) ?? 50;

  const evaluation = evaluateRisk({
    llmBaseScore,
    signals,
    calibrationFactor,
    blastRadiusMultiplier,
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

  // Handle T+5 low confidence — defer, no action
  if (!isPastT30 && evaluation.confidence < LOW_CONFIDENCE_THRESHOLD) {
    checkpoint.decision = 'approved';
    await writeCheckpoint(execution.executionId as string, checkpoint);
    return;
  }

  // Handle T+30 with low confidence — confirm with flag
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
  await ddb.send(
    new UpdateCommand({
      TableName: EXECUTIONS_TABLE_NAME,
      Key: { executionId },
      UpdateExpression:
        'SET checkpoints = list_append(if_not_exists(checkpoints, :empty), :cp), updatedAt = :now',
      ExpressionAttributeValues: {
        ':cp': [checkpoint],
        ':empty': [],
        ':now': Date.now(),
      },
    })
  );
}

async function triggerRollback(
  execution: Record<string, unknown>,
  evaluation: ReturnType<typeof evaluateRisk>,
  checkpointType: 'post-deploy-5' | 'post-deploy-30',
  now: number
): Promise<void> {
  const payload: DeploymentRollbackEvent = {
    executionId: execution.executionId as string,
    repoFullName: execution.repoFullName as string,
    prNumber: execution.prNumber as number,
    reason: evaluation.reason,
    triggeredAt: now,
    checkpointType,
    riskScoreAtTrigger: evaluation.score,
  };
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'pullmint.monitor',
          DetailType: 'deployment.rollback',
          EventBusName: EVENT_BUS_NAME,
          Detail: JSON.stringify(payload),
        },
      ],
    })
  );

  // Write rolled-back status to DynamoDB (don't rely solely on EventBridge delivery)
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: EXECUTIONS_TABLE_NAME,
        Key: { executionId: execution.executionId as string },
        UpdateExpression: 'SET #status = :s, updatedAt = :now',
        ConditionExpression: '#status = :monitoring',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':s': 'rolled-back',
          ':now': now,
          ':monitoring': 'monitoring',
        },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn(
        `[deployment-monitor] Status already advanced past monitoring for ${execution.executionId as string} — skipping status write`
      );
    } else {
      throw err;
    }
  }
}

async function confirmExecution(
  execution: Record<string, unknown>,
  finalScore: number,
  lowConfidence: boolean,
  now: number
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: EXECUTIONS_TABLE_NAME,
      Key: { executionId: execution.executionId as string },
      UpdateExpression: 'SET #status = :s, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': 'confirmed', ':now': now },
    })
  );
  const payload: ExecutionConfirmedEvent = {
    executionId: execution.executionId as string,
    repoFullName: execution.repoFullName as string,
    prNumber: execution.prNumber as number,
    confirmedWithLowConfidence: lowConfidence,
    finalRiskScore: finalScore,
    confirmedAt: now,
  };
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'pullmint.monitor',
          DetailType: 'execution.confirmed',
          EventBusName: EVENT_BUS_NAME,
          Detail: JSON.stringify(payload),
        },
      ],
    })
  );
}
