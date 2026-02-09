import { APIGatewayProxyHandler } from 'aws-lambda';
import { getItem, queryItems } from '../shared/dynamodb';
import { PRExecution } from '../shared/types';

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const executionId = event.pathParameters?.executionId;
    if (executionId) {
      const item = await getItem<PRExecution>(EXECUTIONS_TABLE_NAME, { executionId });
      if (!item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ error: 'Execution not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(item),
      };
    }

    const repoFullName = event.queryStringParameters?.repoFullName;
    if (!repoFullName) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'repoFullName is required' }),
      };
    }

    const limit = Math.min(Number(event.queryStringParameters?.limit || '20'), 100);

    const items = await queryItems<PRExecution>({
      tableName: EXECUTIONS_TABLE_NAME,
      indexName: 'ByRepo',
      keyConditionExpression: '#repo = :repo',
      expressionAttributeNames: { '#repo': 'repoFullName' },
      expressionAttributeValues: { ':repo': repoFullName },
      limit,
      scanIndexForward: false,
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ items }),
    };
  } catch (error) {
    console.error('Dashboard API error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
