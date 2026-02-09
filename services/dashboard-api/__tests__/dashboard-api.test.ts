import { APIGatewayProxyEvent } from 'aws-lambda';

const buildEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent =>
  ({
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/dashboard/executions',
    pathParameters: null,
    queryStringParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
  }) as APIGatewayProxyEvent;

describe('Dashboard API', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.EXECUTIONS_TABLE_NAME = 'test-executions';
  });

  it('rejects non-GET methods', async () => {
    jest.doMock('../shared/dynamodb', () => ({
      getItem: jest.fn(),
      queryItems: jest.fn(),
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ httpMethod: 'POST' });

    const result = await handler(event);

    expect(result.statusCode).toBe(405);
  });

  it('returns execution details when executionId is provided', async () => {
    const getItem = jest.fn().mockResolvedValue({ executionId: 'exec-1' });
    jest.doMock('../shared/dynamodb', () => ({
      getItem,
      queryItems: jest.fn(),
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ pathParameters: { executionId: 'exec-1' } });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ executionId: 'exec-1' });
    expect(getItem).toHaveBeenCalledWith('test-executions', { executionId: 'exec-1' });
  });

  it('returns 404 when executionId is missing', async () => {
    const getItem = jest.fn().mockResolvedValue(null);
    jest.doMock('../shared/dynamodb', () => ({
      getItem,
      queryItems: jest.fn(),
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ pathParameters: { executionId: 'missing' } });

    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('requires repoFullName for list queries', async () => {
    jest.doMock('../shared/dynamodb', () => ({
      getItem: jest.fn(),
      queryItems: jest.fn(),
    }));

    const { handler } = await import('../index');
    const event = buildEvent();

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns execution list for repo', async () => {
    const queryItems = jest.fn().mockResolvedValue([{ executionId: 'exec-2' }]);
    jest.doMock('../shared/dynamodb', () => ({
      getItem: jest.fn(),
      queryItems,
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ queryStringParameters: { repoFullName: 'owner/repo', limit: '5' } });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ items: [{ executionId: 'exec-2' }] });
    expect(queryItems).toHaveBeenCalled();
  });

  it('uses default limit when missing', async () => {
    const queryItems = jest.fn().mockResolvedValue([]);
    jest.doMock('../shared/dynamodb', () => ({
      getItem: jest.fn(),
      queryItems,
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ queryStringParameters: { repoFullName: 'owner/repo' } });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(queryItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 })
    );
  });

  it('returns 500 on unexpected errors', async () => {
    jest.doMock('../shared/dynamodb', () => ({
      getItem: jest.fn().mockRejectedValue(new Error('boom')),
      queryItems: jest.fn(),
    }));

    const { handler } = await import('../index');
    const event = buildEvent({ pathParameters: { executionId: 'exec-1' } });

    const result = await handler(event);

    expect(result.statusCode).toBe(500);
  });
});
