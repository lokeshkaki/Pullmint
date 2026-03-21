import { APIGatewayProxyEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as crypto from 'crypto';
import { handler } from '../index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const eventBridgeMock = mockClient(EventBridgeClient);
const secretsManagerMock = mockClient(SecretsManagerClient);

describe('Webhook Handler', () => {
  const WEBHOOK_SECRET = 'test-webhook-secret';
  const EVENT_BUS_NAME = 'test-event-bus';
  const DEDUP_TABLE_NAME = 'test-dedup-table';
  const EXECUTIONS_TABLE_NAME = 'test-executions-table';

  beforeAll(() => {
    process.env.EVENT_BUS_NAME = EVENT_BUS_NAME;
    process.env.WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:webhook';
    process.env.DEDUP_TABLE_NAME = DEDUP_TABLE_NAME;
    process.env.EXECUTIONS_TABLE_NAME = EXECUTIONS_TABLE_NAME;
  });

  beforeEach(() => {
    ddbMock.reset();
    eventBridgeMock.reset();
    secretsManagerMock.reset();

    // Default mocks
    secretsManagerMock.on(GetSecretValueCommand).resolves({
      SecretString: WEBHOOK_SECRET,
    });
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // dedup read-only check: no existing record
    ddbMock.on(PutCommand).resolves({});
    eventBridgeMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 0,
      Entries: [{ EventId: 'test-event-id' }],
    });
  });

  const createMockEvent = (
    payload: any,
    eventType: string = 'pull_request',
    deliveryId: string = 'test-delivery-123'
  ): APIGatewayProxyEvent => {
    const body = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(body);
    const signature = 'sha256=' + hmac.digest('hex');

    return {
      body,
      headers: {
        'x-github-event': eventType,
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
      },
      httpMethod: 'POST',
      isBase64Encoded: false,
      path: '/webhook',
      pathParameters: null,
      queryStringParameters: null,
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: '',
    };
  };

  const createPRPayload = (action: string = 'opened', prNumber: number = 123) => ({
    action,
    number: prNumber,
    pull_request: {
      number: prNumber,
      title: 'Test PR',
      user: {
        login: 'testuser',
      },
      head: {
        sha: 'abc1234567890def',
      },
      base: {
        sha: 'def0987654321abc',
      },
    },
    repository: {
      full_name: 'owner/repo',
      owner: {
        id: 12345,
        login: 'owner',
      },
    },
  });

  const createDeploymentStatusPayload = (
    state: 'queued' | 'in_progress' | 'success' | 'failure' = 'success'
  ) => ({
    deployment: {
      id: 1,
      environment: 'staging',
      sha: 'abc123',
      payload: {
        executionId: 'exec-123',
        prNumber: 123,
        repoFullName: 'owner/repo',
        deploymentStrategy: 'deployment',
        baseSha: 'def456',
        author: 'testuser',
        title: 'Test PR',
        orgId: 'org_12345',
      },
    },
    deployment_status: {
      state,
      description: 'Deployment update',
    },
    repository: {
      full_name: 'owner/repo',
      owner: {
        id: 12345,
        login: 'owner',
      },
    },
  });

  describe('Signature Validation', () => {
    it('should accept valid GitHub signature', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body)).toMatchObject({
        message: 'Event accepted',
      });
    });

    it('should reject invalid signature', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);
      event.headers['x-hub-signature-256'] = 'sha256=invalid-signature';

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid signature',
      });
    });

    it('should reject missing signature', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);
      delete event.headers['x-hub-signature-256'];

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
    });
  });

  describe('Idempotency', () => {
    it('should process first delivery', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload, 'pull_request', 'delivery-1');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      // GetCommand for dedup check + PutCommand for execution + PutCommand for dedup write
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2); // execution + dedup write
    });

    it('should reject duplicate delivery', async () => {
      const payload = createPRPayload();
      const deliveryId = 'duplicate-delivery';
      const event = createMockEvent(payload, 'pull_request', deliveryId);

      // Reset and create new mock for this test
      ddbMock.reset();
      secretsManagerMock.reset();
      eventBridgeMock.reset();

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: WEBHOOK_SECRET,
      });

      // Dedup read-only check returns existing record
      ddbMock.on(GetCommand).resolves({
        Item: { deliveryId, processedAt: Date.now(), ttl: 123456 },
      });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Already processed',
      });
    });

    it('should reject missing delivery ID', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);
      delete event.headers['x-github-delivery'];

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Missing delivery ID',
      });
    });

    it('should return 200 when execution record already exists for same executionId', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload, 'pull_request', 'retry-delivery-456');

      ddbMock.reset();
      secretsManagerMock.reset();
      secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: WEBHOOK_SECRET });

      // Dedup read-only check returns no existing record
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      // 1st PutCommand (execution record) throws duplicate error
      let putCallCount = 0;
      ddbMock.on(PutCommand).callsFake(() => {
        putCallCount++;
        if (putCallCount === 1) {
          const error: any = new Error('Item already exists');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
        return {};
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: 'Already processing' });
    });

    it('should throw error on DynamoDB error during dedup check', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload, 'pull_request', 'error-delivery');

      // Reset and setup generic error for dedup read check
      ddbMock.reset();
      secretsManagerMock.reset();

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: WEBHOOK_SECRET,
      });

      // getItem (GetCommand) throws generic DynamoDB error
      ddbMock.on(GetCommand).rejects(
        (() => {
          const error: any = new Error('DynamoDB service error');
          error.name = 'ServiceUnavailableException';
          return error;
        })()
      );
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Internal server error',
      });
    });
  });

  describe('Event Filtering', () => {
    it('should process pull_request events', async () => {
      const payload = createPRPayload('opened');
      const event = createMockEvent(payload, 'pull_request');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    it('should ignore non-pull_request events', async () => {
      const payload = { action: 'opened', issue: { number: 1 } };
      const event = createMockEvent(payload, 'issues');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Event type ignored',
      });
      expect(eventBridgeMock.calls()).toHaveLength(0);
    });

    it('should process deployment status events', async () => {
      const payload = createDeploymentStatusPayload('success');
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
      const call = eventBridgeMock.call(0);
      const entry = (call.args[0].input as any).Entries[0];
      expect(entry.DetailType).toBe('deployment.status');
    });

    it('should map in-progress deployment status', async () => {
      const payload = createDeploymentStatusPayload('in_progress');
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const call = eventBridgeMock.call(0);
      const entry = (call.args[0].input as any).Entries[0];
      expect(JSON.parse(entry.Detail).deploymentStatus).toBe('deploying');
    });

    it('should ignore deployment status without execution id', async () => {
      const payload = createDeploymentStatusPayload('failure');
      delete payload.deployment.payload.executionId;
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Deployment status ignored',
      });
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    it('should ignore inactive deployment status', async () => {
      const payload = {
        deployment: {
          id: 1,
          environment: 'staging',
          sha: 'abc123',
          payload: {
            executionId: 'exec-123',
            prNumber: 123,
            repoFullName: 'owner/repo',
            deploymentStrategy: 'deployment',
            baseSha: 'def456',
            author: 'testuser',
            title: 'Test PR',
            orgId: 'org_12345',
          },
        },
        deployment_status: {
          state: 'inactive' as any,
          description: 'Deployment deactivated',
        },
        repository: {
          full_name: 'owner/repo',
          owner: {
            id: 12345,
            login: 'owner',
          },
        },
      };
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Deployment status ignored',
      });
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    it('should map failure deployment status to failed', async () => {
      const payload = createDeploymentStatusPayload('failure');
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const call = eventBridgeMock.call(0);
      const entry = (call.args[0].input as any).Entries[0];
      expect(JSON.parse(entry.Detail).deploymentStatus).toBe('failed');
    });

    it('should map queued deployment status to deploying', async () => {
      const payload = createDeploymentStatusPayload('queued');
      const event = createMockEvent(payload, 'deployment_status');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const call = eventBridgeMock.call(0);
      const entry = (call.args[0].input as any).Entries[0];
      expect(JSON.parse(entry.Detail).deploymentStatus).toBe('deploying');
    });

    it('should process opened PRs', async () => {
      const payload = createPRPayload('opened');
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    it('should process synchronized PRs', async () => {
      const payload = createPRPayload('synchronize');
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    it('should process reopened PRs', async () => {
      const payload = createPRPayload('reopened');
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    it('should handle closed PRs without merge as ignored', async () => {
      const payload = {
        ...createPRPayload('closed'),
        pull_request: {
          ...createPRPayload('closed').pull_request,
          merged: false,
        },
      };
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'PR closed without merge',
      });
    });

    it('should ignore edited PRs', async () => {
      const payload = createPRPayload('edited');
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'PR action ignored',
      });
    });
  });

  describe('Data Processing', () => {
    it('should create execution record with correct data', async () => {
      const payload = createPRPayload('opened', 456);
      const event = createMockEvent(payload);

      const result = await handler(event);

      // Verify successful response
      expect(result.statusCode).toBe(202);

      // Verify DynamoDB was called at least 3 times (dedup check + execution + dedup write)
      const putCalls = ddbMock.calls();
      expect(putCalls.length).toBeGreaterThanOrEqual(3);

      // Verify response includes execution ID
      const responseBody = JSON.parse(result.body);
      expect(responseBody.executionId).toMatch(/owner\/repo#456#/);
    });

    it('should publish event to EventBridge with correct structure', async () => {
      const payload = createPRPayload('opened', 789);
      const event = createMockEvent(payload);

      const result = await handler(event);

      // Verify successful response
      expect(result.statusCode).toBe(202);

      // Verify EventBridge was called
      const eventCalls = eventBridgeMock.calls();
      expect(eventCalls.length).toBeGreaterThan(0);

      // Verify response includes execution ID
      const responseBody = JSON.parse(result.body);
      expect(responseBody.executionId).toBeDefined();
      expect(responseBody.message).toBe('Event accepted');
    });

    it('should generate unique execution IDs', async () => {
      const payload1 = createPRPayload('opened', 1);
      const event1 = createMockEvent(payload1, 'pull_request', 'delivery-1');

      const payload2 = createPRPayload('opened', 2);
      const event2 = createMockEvent(payload2, 'pull_request', 'delivery-2');

      const result1 = await handler(event1);
      const result2 = await handler(event2);

      const executionId1 = JSON.parse(result1.body).executionId;
      const executionId2 = JSON.parse(result2.body).executionId;

      expect(executionId1).not.toBe(executionId2);
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);

      // Reset and setup error for execution record put
      ddbMock.reset();
      secretsManagerMock.reset();

      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: WEBHOOK_SECRET,
      });

      // Dedup read-only check passes
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      // 1st PutCommand (execution record) throws error
      let putCallCount = 0;
      ddbMock.on(PutCommand).callsFake(() => {
        putCallCount++;
        if (putCallCount === 1) {
          throw new Error('DynamoDB error');
        }
        return {};
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Internal server error',
      });
    });

    it('should handle EventBridge errors gracefully', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);

      eventBridgeMock.on(PutEventsCommand).rejects(new Error('EventBridge error'));

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Internal server error',
      });
    });

    it('should accept webhook when secret retrieval succeeds', async () => {
      const payload = createPRPayload();
      const event = createMockEvent(payload);

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    it('should not block retries if EventBridge publish fails after dedup check', async () => {
      const payload = createPRPayload('opened');

      // First call: dedup check passes (no existing record), EventBridge fails
      ddbMock.reset();
      secretsManagerMock.reset();
      secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: WEBHOOK_SECRET });
      ddbMock.on(GetCommand).resolves({ Item: undefined }); // No dedup record
      ddbMock.on(PutCommand).resolves({}); // execution record succeeds
      eventBridgeMock.reset();
      eventBridgeMock.on(PutEventsCommand).rejectsOnce(new Error('EventBridge unavailable'));

      const event1 = createMockEvent(payload, 'pull_request', 'retry-test-delivery');
      const result1 = await handler(event1);
      expect(result1.statusCode).toBe(500); // Error returned to GitHub

      // Second call (GitHub retry with same deliveryId): should NOT be blocked by dedup
      ddbMock.reset();
      secretsManagerMock.reset();
      secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: WEBHOOK_SECRET });
      ddbMock.on(GetCommand).resolves({ Item: undefined }); // No dedup record (wasn't written because EB failed)
      ddbMock.on(PutCommand).resolves({});
      eventBridgeMock.reset();
      eventBridgeMock
        .on(PutEventsCommand)
        .resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'test' }] });

      const event2 = createMockEvent(payload, 'pull_request', 'retry-test-delivery');
      const result2 = await handler(event2);
      expect(result2.statusCode).toBe(202); // Should succeed on retry
    });

    it('should handle malformed JSON payload', async () => {
      const payload = 'invalid-json{';
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      hmac.update(payload);
      const signature = 'sha256=' + hmac.digest('hex');

      const event = createMockEvent({}, 'pull_request');
      event.body = payload;
      event.headers['x-hub-signature-256'] = signature;

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
    });
  });

  describe('Integration', () => {
    it('should complete full successful flow', async () => {
      const payload = createPRPayload('synchronize', 999);
      const event = createMockEvent(payload, 'pull_request', 'integration-test');

      const result = await handler(event);

      // Verify response
      expect(result.statusCode).toBe(202);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.message).toBe('Event accepted');
      expect(responseBody.executionId).toBeDefined();

      // Verify dedup check (GetCommand) + execution record + dedup write
      const getCalls = ddbMock.commandCalls(GetCommand);
      expect(getCalls.length).toBeGreaterThanOrEqual(1); // dedup read-only check

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThanOrEqual(2); // execution + dedup write

      // First PutCommand should be execution record
      const executionInput: any = putCalls[0].args[0].input;
      expect(executionInput.Item.executionId).toBeDefined();

      // Second PutCommand should be dedup write (after EventBridge success)
      const dedupInput: any = putCalls[1].args[0].input;
      expect(dedupInput.Item.deliveryId).toBe('integration-test');

      // Verify event published
      const eventCalls = eventBridgeMock.calls();
      expect(eventCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Installation Events', () => {
    it('should publish repo.onboarding.requested for each repo in installation', async () => {
      const payload = {
        action: 'created',
        installation: { id: 42 },
        repositories: [{ full_name: 'org/repo1' }, { full_name: 'org/repo2' }],
      };
      const event = createMockEvent(payload, 'installation');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body)).toEqual({ message: 'Onboarding triggered' });
      // EventBridge called twice (once per repo)
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(2);
    });

    it('should ignore installation deleted action', async () => {
      const payload = {
        action: 'deleted',
        installation: { id: 42 },
        repositories: [{ full_name: 'org/repo1' }],
      };
      const event = createMockEvent(payload, 'installation');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: 'Installation action ignored' });
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    it('should handle installation_repositories event with repositories_added', async () => {
      const payload = {
        action: 'added',
        installation: { id: 42 },
        repositories_added: [{ full_name: 'org/new-repo' }],
        repositories_removed: [],
      };
      const event = createMockEvent(payload, 'installation_repositories');

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });
  });

  describe('Pull Request Merged', () => {
    it('should publish pr.merged event when merged is true', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 10,
          title: 'Fix bug',
          merged: true,
          merge_commit_sha: 'merge123',
          user: { login: 'alice' },
          head: { sha: 'abc123' },
          base: { sha: 'def456' },
        },
        repository: { full_name: 'org/repo', owner: { id: 1, login: 'org' } },
      };
      const event = createMockEvent(payload, 'pull_request');

      // Mock QueryCommand for best-effort executionId lookup
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body)).toEqual({ message: 'Merge event published' });

      // Verify EventBridge called with pr.merged detail type
      const ebCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(ebCalls.length).toBeGreaterThan(0);
      const entry = (ebCalls[0].args[0].input as any).Entries[0];
      expect(entry.DetailType).toBe('pr.merged');
      const detail = JSON.parse(entry.Detail);
      expect(detail.prNumber).toBe(10);
      expect(detail.author).toBe('alice');
    });

    it('should include executionId from GSI lookup when available', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 10,
          title: 'Fix bug',
          merged: true,
          merge_commit_sha: 'merge123',
          user: { login: 'alice' },
          head: { sha: 'abc123' },
          base: { sha: 'def456' },
        },
        repository: { full_name: 'org/repo', owner: { id: 1, login: 'org' } },
      };
      const event = createMockEvent(payload, 'pull_request');

      ddbMock.on(QueryCommand).resolves({
        Items: [{ executionId: 'exec-found-123' }],
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const ebCalls = eventBridgeMock.commandCalls(PutEventsCommand);
      const detail = JSON.parse((ebCalls[0].args[0].input as any).Entries[0].Detail);
      expect(detail.executionId).toBe('exec-found-123');
    });
  });

  describe('PR Queuing During Onboarding', () => {
    it('should queue execution when repo is still indexing', async () => {
      process.env.REPO_REGISTRY_TABLE_NAME = 'registry-table';

      const payload = createPRPayload('opened');
      const event = createMockEvent(payload);

      // First GetCommand = dedup check (no record), second = repo-registry lookup
      let getCallCount = 0;
      ddbMock.on(GetCommand).callsFake(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return { Item: undefined }; // dedup check: not processed
        }
        return { Item: { repoFullName: 'owner/repo', indexingStatus: 'indexing' } };
      });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body).message).toBe('Queued — repo indexing in progress');
      // Should NOT have published to EventBridge
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
      // UpdateCommand called for appendToList
      expect(ddbMock.commandCalls(UpdateCommand).length).toBeGreaterThan(0);
    });

    it('should proceed normally when repo is indexed', async () => {
      process.env.REPO_REGISTRY_TABLE_NAME = 'registry-table';

      const payload = createPRPayload('opened');
      const event = createMockEvent(payload);

      // First GetCommand = dedup check (no record), second = repo-registry lookup
      let getCallCount = 0;
      ddbMock.on(GetCommand).callsFake(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return { Item: undefined }; // dedup check: not processed
        }
        return { Item: { repoFullName: 'owner/repo', indexingStatus: 'indexed' } };
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body).message).toBe('Event accepted');
    });

    afterEach(() => {
      delete process.env.REPO_REGISTRY_TABLE_NAME;
    });
  });
});
