import type { APIGatewayProxyEvent } from 'aws-lambda';

const createMockEvent = (method = 'GET'): APIGatewayProxyEvent => ({
  path: '/dashboard',
  httpMethod: method,
  headers: {},
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  requestContext: {} as any,
  resource: '',
  body: null,
  isBase64Encoded: false,
});

describe('Dashboard UI redirect handler', () => {
  const originalDashboardUrl = process.env.DASHBOARD_URL;

  afterEach(() => {
    jest.resetModules();
    if (originalDashboardUrl) {
      process.env.DASHBOARD_URL = originalDashboardUrl;
    } else {
      delete process.env.DASHBOARD_URL;
    }
  });

  it('returns a redirect response when DASHBOARD_URL is configured', async () => {
    process.env.DASHBOARD_URL = 'https://d111111abcdef8.cloudfront.net';
    const { handler } = await import('../index');

    const result = await handler(createMockEvent('GET'));

    expect(result.statusCode).toBe(302);
    expect(result.headers).toEqual({
      Location: 'https://d111111abcdef8.cloudfront.net',
      'Cache-Control': 'no-cache',
    });
    expect(result.body).toBe('');
  });

  it('returns service unavailable when DASHBOARD_URL is missing', async () => {
    delete process.env.DASHBOARD_URL;
    const { handler } = await import('../index');

    const result = await handler(createMockEvent('GET'));

    expect(result.statusCode).toBe(503);
    expect(result.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(result.body).toBe('Dashboard URL not configured');
  });

  it('redirects non-GET requests as well when configured', async () => {
    process.env.DASHBOARD_URL = 'https://d111111abcdef8.cloudfront.net';
    const { handler } = await import('../index');

    const result = await handler(createMockEvent('POST'));

    expect(result.statusCode).toBe(302);
    expect(result.headers?.Location).toBe('https://d111111abcdef8.cloudfront.net');
  });
});
