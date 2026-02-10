import { handler } from '../index';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { PRExecution } from '../../shared/types';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Dashboard API Handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.EXECUTIONS_TABLE_NAME = 'test-executions-table';
  });

  const createMockEvent = (
    path: string,
    method: string = 'GET',
    queryParams: Record<string, string> | null = null
  ): APIGatewayProxyEvent => ({
    path,
    httpMethod: method,
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: queryParams,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
  });

  describe('OPTIONS requests (CORS preflight)', () => {
    it('should handle OPTIONS requests', async () => {
      const event = createMockEvent('/dashboard/executions', 'OPTIONS');
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', '*');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Methods', 'GET,OPTIONS');
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
      ddbMock.on(ScanCommand).resolves({ Items: mockExecutions });

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
      ddbMock.on(ScanCommand).resolves({ Items: [mockExecutions[0]] });

      const event = createMockEvent('/dashboard/executions', 'GET', {
        status: 'completed',
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);

      // Verify filter expression was applied
      const scanCall = ddbMock.commandCalls(ScanCommand)[0];
      expect(scanCall.args[0].input.FilterExpression).toContain('status');
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
      ddbMock.on(ScanCommand).resolves({ Items: unsortedExecutions });

      const event = createMockEvent('/dashboard/executions');
      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.executions[0].timestamp).toBeGreaterThan(body.executions[1].timestamp);
    });

    it('should use default limit when not specified', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: mockExecutions });

      const event = createMockEvent('/dashboard/executions');
      await handler(event);

      const scanCall = ddbMock.commandCalls(ScanCommand)[0];
      expect(scanCall.args[0].input.Limit).toBe(50); // DEFAULT_LIMIT
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

      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', '*');
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
      ddbMock.on(ScanCommand).resolves({ Items: undefined });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.executions).toEqual([]);
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

    it('should handle scan with status filter', async () => {
      const event = createMockEvent('/dashboard/executions', 'GET', {
        status: 'failed',
      });

      ddbMock.on(ScanCommand).resolves({
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
      const mockCalls = ddbMock.commandCalls(ScanCommand);
      expect(mockCalls[0].args[0].input.FilterExpression).toBe('#status = :status');
    });

    it('should handle pagination with LastEvaluatedKey', async () => {
      const event = createMockEvent('/dashboard/executions');

      ddbMock.on(ScanCommand).resolves({
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

      ddbMock.on(ScanCommand).resolves({
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

      ddbMock.on(ScanCommand).resolves({
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
});
