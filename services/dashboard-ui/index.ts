import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const DASHBOARD_URL = process.env.DASHBOARD_URL;

export async function handler(_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!DASHBOARD_URL) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Dashboard URL not configured',
    };
  }

  return {
    statusCode: 302,
    headers: {
      Location: DASHBOARD_URL,
      'Cache-Control': 'no-cache',
    },
    body: '',
  };
}
