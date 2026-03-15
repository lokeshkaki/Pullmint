import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';
import type { ExecutionConfirmedEvent, ExecutionRolledBackEvent } from '../../shared/types';
import { handler } from '../index';

const ddbMock = mockClient(DynamoDBDocumentClient);

const CALIBRATION_TABLE = 'test-calibration';
const EXECUTIONS_TABLE = 'test-executions';

beforeAll(() => {
  process.env.CALIBRATION_TABLE_NAME = CALIBRATION_TABLE;
  process.env.EXECUTIONS_TABLE_NAME = EXECUTIONS_TABLE;
});

afterAll(() => {
  delete process.env.CALIBRATION_TABLE_NAME;
  delete process.env.EXECUTIONS_TABLE_NAME;
});

function confirmedEvent(
  executionId: string
): EventBridgeEvent<'execution.confirmed', ExecutionConfirmedEvent> {
  return {
    'detail-type': 'execution.confirmed',
    source: 'pullmint.monitor',
    detail: {
      executionId,
      repoFullName: 'org/repo',
      prNumber: 1,
      confirmedWithLowConfidence: false,
      finalRiskScore: 30,
      confirmedAt: Date.now(),
    },
  } as unknown as EventBridgeEvent<'execution.confirmed', ExecutionConfirmedEvent>;
}

function rolledBackEvent(
  executionId: string
): EventBridgeEvent<'execution.rolled-back', ExecutionRolledBackEvent> {
  return {
    'detail-type': 'execution.rolled-back',
    source: 'pullmint.orchestrator',
    detail: {
      executionId,
      repoFullName: 'org/repo',
      prNumber: 1,
      rollbackSource: 'monitor',
      rolledBackAt: Date.now(),
    },
  } as unknown as EventBridgeEvent<'execution.rolled-back', ExecutionRolledBackEvent>;
}

describe('calibration-service handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    ddbMock.reset();
  });

  it('keeps calibrationFactor at 1.0 until observationsCount reaches 10', async () => {
    // Execution approved, confirmed (true negative) — should not change factor
    // First GetCommand = executions table, second = calibration table
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 25,
          checkpoints: [{ type: 'analysis', decision: 'approved' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 5, calibrationFactor: 1.0 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(confirmedEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const expr = updateCall.args[0].input.UpdateExpression as string;
    // calibrationFactor must NOT be updated (still below 10 observations)
    expect(expr).not.toContain('calibrationFactor');
  });

  it('increases calibrationFactor on false negative (approved + rolled back)', async () => {
    // Execution was approved but rolled back = false negative
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 25,
          checkpoints: [{ type: 'analysis', decision: 'approved' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 15, calibrationFactor: 1.0 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(rolledBackEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall).toBeDefined();
    const newFactor = updateCall.args[0].input.ExpressionAttributeValues?.[':newFactor'] as number;
    expect(newFactor).toBeGreaterThan(1.0); // EMA moved upward
  });

  it('decreases calibrationFactor on false positive (blocked + confirmed fine)', async () => {
    // Execution was held but confirmed fine = false positive
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 45,
          checkpoints: [{ type: 'analysis', decision: 'held' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 15, calibrationFactor: 1.0 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(confirmedEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const newFactor = updateCall.args[0].input.ExpressionAttributeValues?.[':newFactor'] as number;
    expect(newFactor).toBeLessThan(1.0); // EMA moved downward
  });

  it('does not change calibrationFactor on true negative (approved + confirmed)', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 25,
          checkpoints: [{ type: 'analysis', decision: 'approved' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 15, calibrationFactor: 1.0 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(confirmedEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    expect(updateCall).toBeDefined();
    const updateExpr = updateCall.args[0].input.UpdateExpression as string;
    // Only the observation counter and successCount should update — not the factor
    expect(updateExpr).not.toContain(':newFactor');
  });

  it('never allows calibrationFactor to exceed 2.0', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 25,
          checkpoints: [{ type: 'analysis', decision: 'approved' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 100, calibrationFactor: 1.99 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(rolledBackEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const newFactor = updateCall.args[0].input.ExpressionAttributeValues?.[':newFactor'] as number;
    expect(newFactor).toBeLessThanOrEqual(2.0);
  });

  it('never allows calibrationFactor to go below 0.5', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 45,
          checkpoints: [{ type: 'analysis', decision: 'held' }],
        },
      })
      .resolvesOnce({
        Item: { repoFullName: 'org/repo', observationsCount: 100, calibrationFactor: 0.51 },
      });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(confirmedEvent('exec-1'), {} as never, {} as never);

    const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
    const newFactor = updateCall.args[0].input.ExpressionAttributeValues?.[':newFactor'] as number;
    expect(newFactor).toBeGreaterThanOrEqual(0.5);
  });

  it('creates a new calibration record when none exists', async () => {
    ddbMock
      .on(GetCommand)
      .resolvesOnce({
        Item: {
          executionId: 'exec-1',
          riskScore: 25,
          checkpoints: [{ type: 'analysis', decision: 'approved' }],
        },
      })
      .resolvesOnce({ Item: undefined }); // No existing calibration record
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await handler(confirmedEvent('exec-1'), {} as never, {} as never);

    expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
  });

  it('does nothing when execution record is not found', async () => {
    ddbMock.on(GetCommand).resolvesOnce({ Item: undefined });

    await handler(confirmedEvent('missing-exec'), {} as never, {} as never);

    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });
});
