import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { handler } from '../index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

const NOW = 1700000000000;
const T5_AGO = NOW - 6 * 60 * 1000; // 6 minutes ago — past T+5 window
const T30_AGO = NOW - 31 * 60 * 1000; // 31 minutes ago — past T+30 window

// An execution that deployed 6 minutes ago (past T+5, not yet T+30)
const monitoringExecution = {
  executionId: 'exec-1',
  repoFullName: 'org/repo',
  prNumber: 42,
  status: 'monitoring',
  deploymentStartedAt: T5_AGO,
  riskScore: 25,
  signalsReceived: {
    'ci.result:1699999990000': { value: true, source: 'github', receivedAt: T5_AGO },
    'production.error_rate:1699999995000': { value: 2, source: 'datadog', receivedAt: T5_AGO },
    'production.latency:1699999996000': { value: 5, source: 'datadog', receivedAt: T5_AGO },
  },
  checkpoints: [
    {
      type: 'analysis',
      score: 25,
      confidence: 0.5,
      decision: 'approved',
      evaluatedAt: T5_AGO - 10000,
    },
  ],
  calibrationApplied: 1.0,
  repoContext: { blastRadiusMultiplier: 1.0, downstreamDependentCount: 0 },
};

beforeAll(() => {
  process.env.EXECUTIONS_TABLE_NAME = 'test-executions';
  process.env.EVENT_BUS_NAME = 'test-bus';
  process.env.ROLLBACK_RISK_THRESHOLD = '50';
});

afterAll(() => {
  delete process.env.EXECUTIONS_TABLE_NAME;
  delete process.env.EVENT_BUS_NAME;
  delete process.env.ROLLBACK_RISK_THRESHOLD;
});

describe('deployment-monitor handler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    ddbMock.reset();
    ebMock.reset();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes a post-deploy-5 checkpoint when execution is past T+5 window', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [monitoringExecution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThan(0);
    const updateInput = JSON.stringify(updateCalls[0].args[0].input);
    expect(updateInput).toContain('post-deploy-5');
  });

  it('does not rollback when score is below threshold at T+5', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [monitoringExecution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const events = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
    expect(events.every((e) => e.DetailType !== 'deployment.rollback')).toBe(true);
  });

  it('publishes deployment.rollback when score exceeds threshold at T+5', async () => {
    const highRiskExecution = {
      ...monitoringExecution,
      deploymentStartedAt: T5_AGO,
      riskScore: 35,
      signalsReceived: {
        // ci.result (no delta) + error_rate spike (+20) → 35+20=55 > threshold 50
        // 2 of 6 expected signals → confidence 0.33 ≥ 0.3 (avoids low-confidence deferral)
        'ci.result:1699999990000': { value: true, source: 'github', receivedAt: T5_AGO },
        'production.error_rate:1699999995000': { value: 50, source: 'datadog', receivedAt: T5_AGO },
      },
    };
    ddbMock.on(QueryCommand).resolves({ Items: [highRiskExecution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const events = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
    expect(events.some((e) => e.DetailType === 'deployment.rollback')).toBe(true);
  });

  it('defers at T+5 when confidence is below 0.3 (no production signals)', async () => {
    const lowConfidenceExecution = {
      ...monitoringExecution,
      signalsReceived: {},
    };
    ddbMock.on(QueryCommand).resolves({ Items: [lowConfidenceExecution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const events = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
    expect(events.every((e) => e.DetailType !== 'deployment.rollback')).toBe(true);
    expect(events.every((e) => e.DetailType !== 'execution.confirmed')).toBe(true);
  });

  it('publishes execution.confirmed at T+30 when score is stable', async () => {
    const t30Execution = { ...monitoringExecution, deploymentStartedAt: T30_AGO };
    ddbMock.on(QueryCommand).resolves({ Items: [t30Execution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const events = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
    expect(events.some((e) => e.DetailType === 'execution.confirmed')).toBe(true);
  });

  it('confirms with low confidence flag at T+30 when no production signals', async () => {
    const lowConfT30 = {
      ...monitoringExecution,
      deploymentStartedAt: T30_AGO,
      signalsReceived: {},
    };
    ddbMock.on(QueryCommand).resolves({ Items: [lowConfT30] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const events = ebCalls.flatMap((c) => c.args[0].input.Entries ?? []);
    const confirmedEvent = events.find((e) => e.DetailType === 'execution.confirmed');
    expect(confirmedEvent).toBeDefined();
    const detail = JSON.parse(confirmedEvent!.Detail as string);
    expect(detail.confirmedWithLowConfidence).toBe(true);
  });

  it('skips already-checkpointed executions (idempotency)', async () => {
    const alreadyCheckpointed = {
      ...monitoringExecution,
      checkpoints: [
        ...monitoringExecution.checkpoints,
        { type: 'post-deploy-5', score: 25, decision: 'approved', evaluatedAt: T5_AGO + 1000 },
      ],
    };
    ddbMock.on(QueryCommand).resolves({ Items: [alreadyCheckpointed] });

    await handler({} as never, {} as never, {} as never);

    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });

  it('does nothing when query returns no monitoring executions', async () => {
    // Covers the Items = [] default branch when DynamoDB returns no Items field
    ddbMock.on(QueryCommand).resolves({});

    await handler({} as never, {} as never, {} as never);

    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
    expect(ebMock.commandCalls(PutEventsCommand).length).toBe(0);
  });

  it('handles execution with undefined signalsReceived gracefully', async () => {
    // Covers the signalsReceived ?? {} and checkpoints ?? [] fallback branches
    const noSignalsExecution = {
      executionId: 'exec-no-signals',
      repoFullName: 'org/repo',
      prNumber: 99,
      status: 'monitoring',
      deploymentStartedAt: T5_AGO,
      riskScore: 25,
      calibrationApplied: 1.0,
      repoContext: { blastRadiusMultiplier: 1.0 },
      // signalsReceived and checkpoints intentionally absent
    };
    ddbMock.on(QueryCommand).resolves({ Items: [noSignalsExecution] });
    ddbMock.on(UpdateCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

    await handler({} as never, {} as never, {} as never);

    // confidence = 0/6 = 0 < 0.3 → deferred, checkpoint still written
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
  });
});
