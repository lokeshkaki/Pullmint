import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import crypto from 'crypto';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { publishEvent } from '../shared/eventbridge';
import { getSecret } from '../shared/secrets';
import { addTraceAnnotations } from '../shared/tracer';
import type { Signal, SignalType } from '../shared/types';

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const SIGNAL_INGESTION_SECRET_ARN = process.env.SIGNAL_INGESTION_SECRET_ARN!;

// Active statuses that can receive new signals. 'pending' is included in addition to
// the four listed in the design doc to accept pre-analysis signals (e.g. fast CI
// pipelines that complete before Checkpoint 1 finishes).
const ACTIVE_STATUSES = new Set(['pending', 'analyzing', 'completed', 'deploying', 'monitoring']);

const VALID_SIGNAL_TYPES: ReadonlySet<SignalType> = new Set<SignalType>([
  'production.error_rate',
  'production.latency',
  'deployment.status',
  'ci.coverage',
  'ci.result',
  'time_of_day',
  'author_history',
  'simultaneous_deploy',
]);

const REQUIRED_FIELDS: (keyof Signal)[] = ['signalType', 'value', 'source', 'timestamp'];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function respond(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, body: JSON.stringify({ message }) };
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const executionId = event.pathParameters?.executionId;
    if (!executionId) return respond(400, 'Missing executionId');

    // 1. HMAC auth
    const signature = event.headers?.['x-pullmint-signature'];
    if (!signature) return respond(401, 'Missing signature');
    const body = event.body ?? '';
    const secret = await getSecret(SIGNAL_INGESTION_SECRET_ARN);
    if (!verifySignature(body, signature, secret)) return respond(401, 'Invalid signature');

    // 2. Parse and validate body
    let signalData: Record<string, unknown>;
    try {
      signalData = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return respond(400, 'Invalid JSON');
    }
    const missing = REQUIRED_FIELDS.filter((f) => signalData[f] === undefined);
    if (missing.length > 0) return respond(400, `Missing fields: ${missing.join(', ')}`);
    if (!VALID_SIGNAL_TYPES.has(signalData.signalType as SignalType)) {
      return respond(
        400,
        `Invalid signalType. Must be one of: ${[...VALID_SIGNAL_TYPES].join(', ')}`
      );
    }
    const signal = signalData as unknown as Signal;

    // 3. Fetch execution
    const { Item: execution } = await ddb.send(
      new GetCommand({ TableName: EXECUTIONS_TABLE_NAME, Key: { executionId } })
    );
    if (!execution) return respond(404, 'Execution not found');
    if (!ACTIVE_STATUSES.has(execution.status as string)) {
      return respond(400, `Execution is in terminal state: ${execution.status as string}`);
    }

    addTraceAnnotations({ executionId });

    // 4. Idempotency check — key: `${signalType}:${timestamp}`
    const signalKey = `${signal.signalType}:${signal.timestamp}`;
    const existingMap = execution.signalsReceived as Record<string, unknown> | undefined;
    if (existingMap?.[signalKey]) return respond(200, 'Signal already recorded');

    // 5. Store signal — single conditional update per path to avoid DynamoDB
    // PathNotFoundException when signalsReceived map does not yet exist.
    const signalEntry = { value: signal.value, source: signal.source, receivedAt: Date.now() };
    if (existingMap) {
      // Map exists — use nested path SET (concurrent-safe, no overwrite of other keys)
      await ddb.send(
        new UpdateCommand({
          TableName: EXECUTIONS_TABLE_NAME,
          Key: { executionId },
          UpdateExpression: 'SET #sr.#key = :signal, updatedAt = :now',
          ExpressionAttributeNames: { '#sr': 'signalsReceived', '#key': signalKey },
          ExpressionAttributeValues: { ':signal': signalEntry, ':now': Date.now() },
        })
      );
    } else {
      // Map absent — write the whole map in one shot
      await ddb.send(
        new UpdateCommand({
          TableName: EXECUTIONS_TABLE_NAME,
          Key: { executionId },
          UpdateExpression: 'SET signalsReceived = :signals, updatedAt = :now',
          ExpressionAttributeValues: {
            ':signals': { [signalKey]: signalEntry },
            ':now': Date.now(),
          },
        })
      );
    }

    // 6. Publish event via shared helper (includes 256KB guard and FailedEntryCount check)
    await publishEvent(EVENT_BUS_NAME, 'pullmint.signals', 'signal.received', {
      executionId,
      signalKey,
      signal: signal as unknown as Record<string, unknown>,
    });

    return respond(200, 'Signal recorded');
  } catch (error) {
    console.error('Signal ingestion error:', error);
    return respond(500, 'Internal server error');
  }
};
