import { handler } from '../index';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { PRExecution } from '../../shared/types';
import { publishEvent } from '../../shared/eventbridge';

jest.mock('../../shared/eventbridge', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Dashboard API Handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockPublishEvent.mockReset();
    mockPublishEvent.mockResolvedValue(undefined);
    process.env.EXECUTIONS_TABLE_NAME = 'test-executions-table';
    process.env.DASHBOARD_AUTH_TOKEN = 'test-token';
    process.env.CALIBRATION_TABLE_NAME = 'test-calibration-table';
    process.env.DEDUP_TABLE_NAME = 'test-dedup-table';
    process.env.REPO_REGISTRY_TABLE_NAME = 'test-registry-table';
    process.env.DASHBOARD_ALLOWED_ORIGINS = 'https://dashboard.pullmint.io,https://localhost:3000';
  });

  afterEach(() => {
    delete process.env.DASHBOARD_AUTH_TOKEN;
    delete process.env.CALIBRATION_TABLE_NAME;
    delete process.env.DEDUP_TABLE_NAME;
    delete process.env.REPO_REGISTRY_TABLE_NAME;
    delete process.env.DASHBOARD_ALLOWED_ORIGINS;
  });

  const createMockEvent = (
    path: string,
    method: string = 'GET',
    queryParams: Record<string, string> | null = null,
    headers: Record<string, string> = {
      Authorization: 'Bearer test-token',
      origin: 'https://dashboard.pullmint.io',
    },
    body: string | null = null
  ): APIGatewayProxyEvent => ({
    path,
    httpMethod: method,
    headers,
    multiValueHeaders: {},
    queryStringParameters: queryParams,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body,
    isBase64Encoded: false,
  });

  describe('OPTIONS requests (CORS preflight)', () => {
    it('should handle OPTIONS requests', async () => {
      const event = createMockEvent('/dashboard/executions', 'OPTIONS');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty(
        'Access-Control-Allow-Origin',
        'https://dashboard.pullmint.io'
      );
      expect(result.headers).toHaveProperty('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      expect(result.headers).toHaveProperty('Vary', 'Origin');
    });
  });

  describe('CORS origin matching', () => {
    it('should return matching origin, not wildcard', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const event = createMockEvent('/dashboard/executions', 'GET', null, {
        Authorization: 'Bearer test-token',
        origin: 'https://dashboard.pullmint.io',
      });

      const result = await handler(event);
      expect(result.headers!['Access-Control-Allow-Origin']).toBe('https://dashboard.pullmint.io');
    });

    it('should return empty origin for non-matching request', async () => {
      const event = createMockEvent('/dashboard/executions', 'GET', null, {
        Authorization: 'Bearer test-token',
        origin: 'https://evil.com',
      });

      const result = await handler(event);
      expect(result.headers!['Access-Control-Allow-Origin']).toBe('');
    });

    it('should return empty origin when no origin header is sent', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const event = createMockEvent('/dashboard/executions', 'GET', null, {
        Authorization: 'Bearer test-token',
      });

      const result = await handler(event);
      expect(result.headers!['Access-Control-Allow-Origin']).toBe('');
    });
  });

  describe('Method validation', () => {
    it('should reject non-GET/OPTIONS requests', async () => {
      const event = createMockEvent('/dashboard/executions', 'POST');
      const result = await handler(event);

      expect(result.statusCode).toBe(405);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Method not allowed');
    });
  });

  describe('Authorization', () => {
    afterEach(() => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
    });

    it('should reject requests without a token when auth is enabled', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-token';
      // Explicitly pass no auth header
      const event = createMockEvent('/dashboard/executions', 'GET', null, {});

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Unauthorized');
    });

    it('should return 503 when DASHBOARD_AUTH_TOKEN is not configured', async () => {
      delete process.env.DASHBOARD_AUTH_TOKEN;
      const event = createMockEvent('/dashboard/executions', 'GET', null, {});

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      expect(JSON.parse(result.body)).toHaveProperty(
        'error',
        'Service unavailable: authentication not configured'
      );
    });

    it('should allow requests with a valid bearer token', async () => {
      process.env.DASHBOARD_AUTH_TOKEN = 'test-token';
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const event = createMockEvent('/dashboard/executions', 'GET', null, {
        Authorization: 'Bearer test-token',
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });
  });

  describe('GET /dashboard/executions/:executionId', () => {
    const executionId = 'test-exec-123';
    const mockExecution: PRExecution = {
      executionId,
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'abc123def456',
      status: 'completed',
      timestamp: Date.now(),
      riskScore: 25,
      findings: [
        {
          type: 'architecture',
          severity: 'medium',
          title: 'Test finding',
          description: 'Test description',
        },
      ],
    };

    it('should return execution details', async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockExecution });

      const event = createMockEvent(`/dashboard/executions/${executionId}`);
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executionId).toBe(executionId);
      expect(body.repoFullName).toBe('owner/repo');
      expect(body.riskScore).toBe(25);
    });

    it('should return 404 for non-existent execution', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createMockEvent(`/dashboard/executions/${executionId}`);
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Execution not found');
    });

    it('should handle DynamoDB errors', async () => {
      ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

      const event = createMockEvent(`/dashboard/executions/${executionId}`);
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Internal server error');
    });
  });

  describe('GET /dashboard/repos/:owner/:repo/prs/:number', () => {
    const mockExecutions: PRExecution[] = [
      {
        executionId: 'exec-1',
        repoFullName: 'owner/repo',
        prNumber: 42,
        headSha: 'abc123',
        status: 'completed',
        timestamp: Date.now(),
        riskScore: 25,
      },
      {
        executionId: 'exec-2',
        repoFullName: 'owner/repo',
        prNumber: 42,
        headSha: 'def456',
        status: 'analyzing',
        timestamp: Date.now() - 10000,
      },
    ];

    it('should return executions for a specific PR', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: mockExecutions });

      const event = createMockEvent('/dashboard/repos/owner/repo/prs/42');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it('should respect limit parameter', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [mockExecutions[0]] });

      const event = createMockEvent('/dashboard/repos/owner/repo/prs/42', 'GET', {
        limit: '1',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toHaveLength(1);
    });

    it('should enforce maximum limit', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: mockExecutions });

      const event = createMockEvent('/dashboard/repos/owner/repo/prs/42', 'GET', {
        limit: '500', // Exceeds MAX_LIMIT (100)
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      // Should clamp to MAX_LIMIT
      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.Limit).toBe(100);
    });

    it('should handle pagination with nextToken', async () => {
      const lastEvaluatedKey = { executionId: 'exec-1' };
      ddbMock.on(QueryCommand).resolves({
        Items: mockExecutions,
        LastEvaluatedKey: lastEvaluatedKey,
      });

      const event = createMockEvent('/dashboard/repos/owner/repo/prs/42');
      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('nextToken');

      // Verify nextToken can be decoded
      const decodedKey = JSON.parse(Buffer.from(body.nextToken, 'base64').toString());
      expect(decodedKey).toEqual(lastEvaluatedKey);
    });
  });

  describe('GET /dashboard/executions', () => {
    const mockExecutions: PRExecution[] = [
      {
        executionId: 'exec-1',
        repoFullName: 'owner/repo1',
        prNumber: 1,
        headSha: 'abc123',
        status: 'completed',
        timestamp: Date.now(),
        riskScore: 25,
      },
      {
        executionId: 'exec-2',
        repoFullName: 'owner/repo2',
        prNumber: 2,
        headSha: 'def456',
        status: 'analyzing',
        timestamp: Date.now() - 10000,
      },
    ];

    it('should list all executions without filters', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: mockExecutions });

      const event = createMockEvent('/dashboard/executions');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it('should filter by repo using GSI query', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [mockExecutions[0]] });

      const event = createMockEvent('/dashboard/executions', 'GET', {
        repo: 'owner/repo1',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toHaveLength(1);

      // Verify GSI query was used
      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('ByRepo');
    });

    it('should filter by status', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [mockExecutions[0]] });

      const event = createMockEvent('/dashboard/executions', 'GET', {
        status: 'completed',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      // Verify filter expression was applied
      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.FilterExpression).toContain('status');
    });

    it('should filter by both repo and status', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [mockExecutions[0]] });

      const event = createMockEvent('/dashboard/executions', 'GET', {
        repo: 'owner/repo1',
        status: 'completed',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      // Verify query with filter
      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('ByRepo');
      expect(queryCall.args[0].input.FilterExpression).toContain('status');
    });

    it('should sort executions by timestamp descending', async () => {
      const unsortedExecutions = [
        { ...mockExecutions[0], timestamp: 1000 },
        { ...mockExecutions[1], timestamp: 2000 },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: unsortedExecutions });

      const event = createMockEvent('/dashboard/executions');
      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.executions[0].timestamp).toBeGreaterThan(body.executions[1].timestamp);
    });

    it('should use default limit when not specified', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: mockExecutions });

      const event = createMockEvent('/dashboard/executions');
      await handler(event);

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.Limit).toBe(50); // DEFAULT_LIMIT
    });
  });

  describe('Error handling', () => {
    it('should return 404 for unknown paths', async () => {
      const event = createMockEvent('/dashboard/unknown');
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Not found');
    });

    it('should include CORS headers in error responses', async () => {
      const event = createMockEvent('/dashboard/unknown');
      const result = await handler(event);

      expect(result.headers).toHaveProperty(
        'Access-Control-Allow-Origin',
        'https://dashboard.pullmint.io'
      );
      expect(result.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('should handle missing environment variables gracefully', async () => {
      delete process.env.EXECUTIONS_TABLE_NAME;
      ddbMock.on(QueryCommand).rejects(new Error('ResourceNotFoundException'));

      const event = createMockEvent('/dashboard/executions');
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
    });

    it('should handle non-Error exceptions', async () => {
      const event = createMockEvent('/dashboard/executions/test-123');
      ddbMock.on(GetCommand).rejects('String error');

      const result = await handler(event);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).message).toBe('String error');
    });

    it('should handle empty Items from DynamoDB', async () => {
      const event = createMockEvent('/dashboard/executions');
      ddbMock.on(QueryCommand).resolves({ Items: undefined });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toEqual([]);
    });

    it('should return 400 for invalid nextToken format in listExecutions', async () => {
      const nextToken = Buffer.from(JSON.stringify('not-an-object')).toString('base64');
      const event = createMockEvent('/dashboard/executions', 'GET', { nextToken });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Invalid nextToken');
    });

    it('should return 400 for array nextToken in getExecutionsByPR', async () => {
      const nextToken = Buffer.from(JSON.stringify([])).toString('base64');
      const event = createMockEvent('/dashboard/repos/owner/repo/prs/42', 'GET', {
        nextToken,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Invalid nextToken');
    });
  });

  describe('Advanced query scenarios', () => {
    it('should handle repo filter with status in listExecutions', async () => {
      const event = createMockEvent('/dashboard/executions', 'GET', {
        repo: 'owner/repo',
        status: 'completed',
      });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            executionId: 'exec-1',
            repo: 'owner/repo',
            prNumber: 1,
            status: 'completed',
            timestamp: 1000,
          },
        ],
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const mockCalls = ddbMock.commandCalls(QueryCommand);
      expect(mockCalls[0].args[0].input.FilterExpression).toBe('#status = :status');
    });

    it('should handle query with status filter', async () => {
      const event = createMockEvent('/dashboard/executions', 'GET', {
        status: 'failed',
      });

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            executionId: 'exec-1',
            repo: 'owner/repo',
            prNumber: 1,
            status: 'failed',
            timestamp: 1000,
          },
        ],
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const mockCalls = ddbMock.commandCalls(QueryCommand);
      expect(mockCalls[0].args[0].input.FilterExpression).toBe('#status = :status');
    });

    it('should handle pagination with LastEvaluatedKey', async () => {
      const event = createMockEvent('/dashboard/executions');

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            executionId: 'exec-1',
            repo: 'owner/repo',
            prNumber: 1,
            status: 'completed',
            timestamp: 1000,
          },
        ],
        LastEvaluatedKey: { executionId: 'exec-1' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.nextToken).toBeDefined();
    });

    it('should sort executions with different timestamps', async () => {
      const event = createMockEvent('/dashboard/executions');

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            executionId: 'exec-1',
            timestamp: 1000,
          },
          {
            executionId: 'exec-2',
            timestamp: 2000,
          },
          {
            executionId: 'exec-3',
            timestamp: 1500,
          },
        ],
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions[0].executionId).toBe('exec-2'); // Latest first
      expect(body.executions[1].executionId).toBe('exec-3');
      expect(body.executions[2].executionId).toBe('exec-1');
    });

    it('should handle executions without timestamps', async () => {
      const event = createMockEvent('/dashboard/executions');

      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            executionId: 'exec-1',
          },
          {
            executionId: 'exec-2',
            timestamp: 1000,
          },
        ],
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toHaveLength(2);
    });
  });

  describe('GET /dashboard/board', () => {
    it('should return executions grouped by status', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event = createMockEvent('/dashboard/board');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('board');
      expect(body.board).toHaveProperty('analyzing');
      expect(body.board).toHaveProperty('monitoring');
      expect(body.board).toHaveProperty('confirmed');
    });

    it('should include execution fields in board cards', async () => {
      const now = Date.now();
      ddbMock
        .on(QueryCommand)
        .resolves({ Items: [] })
        .on(QueryCommand, {
          ExpressionAttributeValues: { ':s': 'monitoring' },
        })
        .resolves({
          Items: [
            {
              executionId: 'exec-mon-1',
              repoFullName: 'owner/repo',
              prNumber: 10,
              title: 'Fix bug',
              author: 'dev',
              riskScore: 35,
              confidenceScore: 0.7,
              deploymentStartedAt: now - 5000,
              checkpoints: [{ type: 'pre-deploy' }],
            },
          ],
        });

      const event = createMockEvent('/dashboard/board');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/board', 'GET', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/executions/:id/checkpoints', () => {
    it('should return checkpoint data for an execution', async () => {
      const mockItem = {
        executionId: 'exec-123',
        checkpoints: [{ type: 'analysis', score: 28, decision: 'approved' }],
        signalsReceived: { 'ci.result:1700000000000': { value: true, source: 'github' } },
        repoContext: { isSharedDependency: false, blastRadiusMultiplier: 1.0 },
        calibrationApplied: 1.0,
      };
      ddbMock.on(GetCommand).resolves({ Item: mockItem });

      const event = createMockEvent('/dashboard/executions/exec-123/checkpoints');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executionId).toBe('exec-123');
      expect(body.checkpoints).toHaveLength(1);
      expect(body.checkpoints[0]).toMatchObject({ type: 'analysis' });
      expect(body.signalsReceived['ci.result:1700000000000']).toBeDefined();
      expect(body.calibrationApplied).toBe(1.0);
    });

    it('should return 404 when execution not found', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createMockEvent('/dashboard/executions/missing-exec/checkpoints');
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Execution not found');
    });

    it('should default missing fields to empty values', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { executionId: 'exec-123' } });

      const event = createMockEvent('/dashboard/executions/exec-123/checkpoints');
      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.checkpoints).toEqual([]);
      expect(body.signalsReceived).toEqual({});
      expect(body.repoContext).toBeNull();
      expect(body.calibrationApplied).toBeNull();
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/executions/exec-123/checkpoints', 'GET', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/calibration', () => {
    it('should return all repos sorted by calibrationFactor descending', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { repoFullName: 'owner/repo-a', calibrationFactor: 1.1, observationsCount: 15 },
          { repoFullName: 'owner/repo-b', calibrationFactor: 1.3, observationsCount: 20 },
          { repoFullName: 'owner/repo-c', calibrationFactor: 0.9, observationsCount: 12 },
        ],
      });

      const event = createMockEvent('/dashboard/calibration');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.repos).toHaveLength(3);
      expect(body.repos[0].repoFullName).toBe('owner/repo-b'); // highest factor first
      expect(body.repos[2].repoFullName).toBe('owner/repo-c'); // lowest factor last
    });

    it('should return empty array when no calibration data', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const event = createMockEvent('/dashboard/calibration');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).repos).toEqual([]);
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/calibration', 'GET', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('GET /dashboard/calibration/:owner/:repo', () => {
    it('should return calibration record for a specific repo', async () => {
      const mockRecord = {
        repoFullName: 'owner/repo',
        calibrationFactor: 1.15,
        observationsCount: 22,
        successCount: 18,
        rollbackCount: 4,
        falsePositiveCount: 1,
        falseNegativeCount: 3,
      };
      ddbMock.on(GetCommand).resolves({ Item: mockRecord });

      const event = createMockEvent('/dashboard/calibration/owner/repo');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.repoFullName).toBe('owner/repo');
      expect(body.calibrationFactor).toBe(1.15);
    });

    it('should return 404 when repo not found', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createMockEvent('/dashboard/calibration/owner/unknown-repo');
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Calibration record not found');
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/calibration/owner/repo', 'GET', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('POST /dashboard/executions/:id/re-evaluate', () => {
    it('should return 202 and log override on success', async () => {
      // First GetCommand (rate-limit check) returns no item; second (update) is a write
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const event = createMockEvent(
        '/dashboard/executions/exec-123/re-evaluate',
        'POST',
        null,
        { Authorization: 'Bearer test-token' },
        JSON.stringify({ justification: 'Manual check needed' })
      );
      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body)).toHaveProperty('message', 'Re-evaluation logged');
    });

    it('should return 429 when called within 2 minutes of a previous call', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { deliveryId: 'reeval:exec-123', ttl: 9999 } });

      const event = createMockEvent('/dashboard/executions/exec-123/re-evaluate', 'POST', null, {
        Authorization: 'Bearer test-token',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(429);
      expect(JSON.parse(result.body)).toHaveProperty('error');
    });

    it('should work without a justification body', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const event = createMockEvent('/dashboard/executions/exec-123/re-evaluate', 'POST', null, {
        Authorization: 'Bearer test-token',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/executions/exec-123/re-evaluate', 'POST', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('should reject non-re-evaluate POST requests with 405', async () => {
      const event = createMockEvent('/dashboard/executions', 'POST');
      const result = await handler(event);
      expect(result.statusCode).toBe(405);
    });
  });

  describe('GET /dashboard/repos/:owner/:repo', () => {
    it('returns 200 with registry record when repo is indexed', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          repoFullName: 'org/repo',
          indexingStatus: 'indexed',
          contextVersion: 5,
          pendingBatches: 0,
          queuedExecutionIds: [],
        },
      });

      const event = createMockEvent('/dashboard/repos/org/repo');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body) as { indexingStatus: string };
      expect(body.indexingStatus).toBe('indexed');
    });

    it('returns 404 when repo is not registered', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createMockEvent('/dashboard/repos/org/unknown');
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Repo not registered');
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/repos/org/repo', 'GET', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('POST /dashboard/repos/:owner/:repo/reindex', () => {
    it('resets registry status and publishes onboarding event', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { repoFullName: 'org/repo', indexingStatus: 'indexed' },
      });
      ddbMock.on(UpdateCommand).resolves({});

      const event = createMockEvent('/dashboard/repos/org/repo/reindex', 'POST', null, {
        Authorization: 'Bearer test-token',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Reindex triggered');
      expect(body.repoFullName).toBe('org/repo');
      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.any(String),
        'pullmint.github',
        'repo.onboarding.requested',
        expect.objectContaining({ repoFullName: 'org/repo' })
      );
    });

    it('returns 404 when repo is not registered', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createMockEvent('/dashboard/repos/org/unknown/reindex', 'POST', null, {
        Authorization: 'Bearer test-token',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toHaveProperty('error', 'Repo not registered');
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    it('should require auth', async () => {
      const event = createMockEvent('/dashboard/repos/org/repo/reindex', 'POST', null, {});
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });
});
