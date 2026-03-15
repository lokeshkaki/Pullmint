import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import crypto from 'crypto';
import { handler } from '../index';
import { clearSecretsCache } from '../../shared/secrets';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const secretsMock = mockClient(SecretsManagerClient);

const HMAC_SECRET = 'test-hmac-secret';
const EXECUTIONS_TABLE = 'test-executions-table';
const EVENT_BUS_NAME_VAL = 'test-event-bus';

beforeAll(() => {
  process.env.EXECUTIONS_TABLE_NAME = EXECUTIONS_TABLE;
  process.env.EVENT_BUS_NAME = EVENT_BUS_NAME_VAL;
  process.env.SIGNAL_INGESTION_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';
});

afterAll(() => {
  delete process.env.EXECUTIONS_TABLE_NAME;
  delete process.env.EVENT_BUS_NAME;
  delete process.env.SIGNAL_INGESTION_SECRET_ARN;
});

function makeSignature(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
}

function makeEvent(executionId: string, body: object, signature?: string): APIGatewayProxyEvent {
  const bodyStr = JSON.stringify(body);
  return {
    pathParameters: { executionId },
    body: bodyStr,
    headers: {
      'x-pullmint-signature': signature ?? makeSignature(bodyStr),
    },
  } as unknown as APIGatewayProxyEvent;
}

const validSignal = {
  signalType: 'production.error_rate',
  value: 5,
  source: 'datadog',
  timestamp: 1700000000000,
};

describe('signal-ingestion handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    ddbMock.reset();
    ebMock.reset();
    secretsMock.reset();
    clearSecretsCache();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: HMAC_SECRET });
  });

  it('returns 200 and stores signal for a valid active execution', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { executionId: 'exec-1', status: 'monitoring' },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

    expect(result?.statusCode).toBe(200);
    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    // Key format: `${signalType}:${timestamp}`
    expect(JSON.stringify(updateCall.args[0].input)).toContain(
      'production.error_rate:1700000000000'
    );
  });

  it('returns 404 when executionId does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await handler(makeEvent('nonexistent', validSignal), {} as never, {} as never);

    expect(result?.statusCode).toBe(404);
  });

  it('returns 400 when execution is in a terminal state', async () => {
    for (const status of ['confirmed', 'rolled-back', 'deployment-blocked', 'failed']) {
      ddbMock.on(GetCommand).resolves({ Item: { executionId: 'exec-1', status } });

      const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

      expect(result?.statusCode).toBe(400);
      ddbMock.reset();
    }
  });

  it('returns 401 when HMAC signature is missing', async () => {
    const bodyStr = JSON.stringify(validSignal);
    const event = {
      pathParameters: { executionId: 'exec-1' },
      body: bodyStr,
      headers: {},
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event, {} as never, {} as never);

    expect(result?.statusCode).toBe(401);
  });

  it('returns 401 when HMAC signature is invalid', async () => {
    const result = await handler(
      makeEvent('exec-1', validSignal, 'sha256=invalidsignature'),
      {} as never,
      {} as never
    );
    expect(result?.statusCode).toBe(401);
  });

  it('is idempotent — duplicate signal (same type+timestamp) is a no-op', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: 'exec-1',
        status: 'monitoring',
        signalsReceived: {
          'production.error_rate:1700000000000': {
            value: 5,
            source: 'datadog',
            receivedAt: 1700000001000,
          },
        },
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

    expect(result?.statusCode).toBe(200);
    // UpdateCommand should not have been called for duplicate
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });

  it('publishes signal.received event to EventBridge on success', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { executionId: 'exec-1', status: 'monitoring' } });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

    const ebCall = ebMock.commandCalls(PutEventsCommand)[0];
    const entry = ebCall.args[0].input.Entries?.[0];
    expect(entry?.DetailType).toBe('signal.received');
    expect(entry?.Source).toBe('pullmint.signals');
  });

  it('returns 400 when body is missing required fields', async () => {
    const body = { signalType: 'production.error_rate' }; // missing value, source, timestamp
    const result = await handler(makeEvent('exec-1', body), {} as never, {} as never);
    expect(result?.statusCode).toBe(400);
  });

  it('returns 400 when executionId is missing from path', async () => {
    const event = {
      pathParameters: null,
      body: JSON.stringify(validSignal),
      headers: {},
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event, {} as never, {} as never);
    expect(result?.statusCode).toBe(400);
  });

  it('treats null body as empty string for HMAC verification', async () => {
    // Include a signature header so we reach the body ?? '' line (line 54) before
    // the invalid-signature branch returns 401
    const event = {
      pathParameters: { executionId: 'exec-1' },
      body: null,
      headers: { 'x-pullmint-signature': 'sha256=doesnotmatch' },
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event, {} as never, {} as never);
    // Signature mismatch → 401 (but body ?? '' was evaluated)
    expect(result?.statusCode).toBe(401);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const event = {
      pathParameters: { executionId: 'exec-1' },
      body: 'not-valid-json{{{',
      headers: {
        'x-pullmint-signature':
          'sha256=' +
          crypto.createHmac('sha256', HMAC_SECRET).update('not-valid-json{{{').digest('hex'),
      },
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event, {} as never, {} as never);
    expect(result?.statusCode).toBe(400);
  });

  it('accepts all active execution statuses', async () => {
    for (const status of ['pending', 'analyzing', 'completed', 'deploying', 'monitoring']) {
      ddbMock.on(GetCommand).resolves({ Item: { executionId: 'exec-1', status } });
      ddbMock.on(UpdateCommand).resolves({});
      ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

      const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

      expect(result?.statusCode).toBe(200);
      ddbMock.reset();
      ebMock.reset();
    }
  });

  it('returns 400 for an unknown signalType', async () => {
    const body = { ...validSignal, signalType: 'unknown.type' };
    const result = await handler(makeEvent('exec-1', body), {} as never, {} as never);
    expect(result?.statusCode).toBe(400);
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({
      message: expect.stringContaining('Invalid signalType'),
    });
  });

  it('returns 500 when an unexpected error occurs', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB unavailable'));

    const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

    expect(result?.statusCode).toBe(500);
  });

  it('uses nested SET when signalsReceived map already exists', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: 'exec-1',
        status: 'monitoring',
        signalsReceived: {
          'ci.result:1699999990000': { value: true, source: 'github', receivedAt: 1699999990000 },
        },
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    const result = await handler(makeEvent('exec-1', validSignal), {} as never, {} as never);

    expect(result?.statusCode).toBe(200);
    const updateInput = JSON.stringify(ddbMock.commandCalls(UpdateCommand)[0].args[0].input);
    expect(updateInput).toContain('signalsReceived');
    expect(updateInput).toContain('production.error_rate:1700000000000');
  });
});
