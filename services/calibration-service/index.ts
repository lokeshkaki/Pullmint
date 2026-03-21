import type { EventBridgeEvent } from 'aws-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { ExecutionConfirmedEvent, ExecutionRolledBackEvent } from '../shared/types';
import { CheckpointRecordSchema } from '../shared/schemas';

const CALIBRATION_TABLE_NAME = process.env.CALIBRATION_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;

const MIN_OBSERVATIONS = 10;
const ALPHA = 0.05;
const MAX_FACTOR = 2.0;
const MIN_FACTOR = 0.5;
const AnalysisCheckpointSchema = CheckpointRecordSchema.pick({ type: true, decision: true });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (
  event: EventBridgeEvent<string, ExecutionConfirmedEvent | ExecutionRolledBackEvent>
): Promise<void> => {
  const isConfirmed = event['detail-type'] === 'execution.confirmed';
  const detail = event.detail as { executionId: string; repoFullName: string };
  const { executionId, repoFullName } = detail;

  // 1. Get execution to find the analysis checkpoint decision
  const { Item: execution } = await ddb.send(
    new GetCommand({ TableName: EXECUTIONS_TABLE_NAME, Key: { executionId } })
  );
  if (!execution) return;

  const rawCheckpoints = (execution.checkpoints as unknown[]) ?? [];
  const checkpoints = rawCheckpoints
    .map((checkpoint) => AnalysisCheckpointSchema.safeParse(checkpoint))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  const analysisCheckpoint = checkpoints.find((c) => c.type === 'analysis');
  const decision = analysisCheckpoint?.decision as 'approved' | 'held' | undefined;

  // 2. Get or create calibration record
  const { Item: calRecord } = await ddb.send(
    new GetCommand({ TableName: CALIBRATION_TABLE_NAME, Key: { repoFullName } })
  );

  if (!calRecord) {
    await ddb.send(
      new PutCommand({
        TableName: CALIBRATION_TABLE_NAME,
        Item: {
          repoFullName,
          observationsCount: 0,
          successCount: 0,
          rollbackCount: 0,
          falsePositiveCount: 0,
          falseNegativeCount: 0,
          calibrationFactor: 1.0,
          lastUpdatedAt: Date.now(),
        },
        ConditionExpression: 'attribute_not_exists(repoFullName)',
      })
    );
  }

  const observationsCount = (calRecord?.observationsCount as number) ?? 0;
  const oldFactor = (calRecord?.calibrationFactor as number) ?? 1.0;

  // 3. Classify outcome
  const isFalseNegative = decision === 'approved' && !isConfirmed; // approved but rolled back
  const isFalsePositive = decision === 'held' && isConfirmed; // held but confirmed fine

  // 4. Build update expression (ADD for atomic increments, SET for assignments)
  const addClauses: string[] = ['observationsCount :inc'];
  const setClauses: string[] = ['lastUpdatedAt = :now'];
  const exprValues: Record<string, unknown> = { ':inc': 1, ':now': Date.now() };

  if (isConfirmed) {
    addClauses.push('successCount :inc');
  } else {
    addClauses.push('rollbackCount :inc');
  }

  if (isFalseNegative) {
    addClauses.push('falseNegativeCount :inc');
  } else if (isFalsePositive) {
    addClauses.push('falsePositiveCount :inc');
  }

  // Factor update: only on false outcomes when observationsCount >= threshold
  if (observationsCount >= MIN_OBSERVATIONS) {
    if (isFalseNegative) {
      const target = Math.min(MAX_FACTOR, oldFactor + 0.15);
      const newFactor = Math.min(MAX_FACTOR, oldFactor + ALPHA * (target - oldFactor));
      setClauses.push('calibrationFactor = :newFactor');
      exprValues[':newFactor'] = newFactor;
    } else if (isFalsePositive) {
      const target = Math.max(MIN_FACTOR, oldFactor - 0.15);
      const newFactor = Math.max(MIN_FACTOR, oldFactor + ALPHA * (target - oldFactor));
      setClauses.push('calibrationFactor = :newFactor');
      exprValues[':newFactor'] = newFactor;
    }
  }

  const updateExpression = `SET ${setClauses.join(', ')} ADD ${addClauses.join(', ')}`;

  await ddb.send(
    new UpdateCommand({
      TableName: CALIBRATION_TABLE_NAME,
      Key: { repoFullName },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: exprValues,
    })
  );
};
