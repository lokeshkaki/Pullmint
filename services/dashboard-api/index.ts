import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  APIGatewayProxyEventQueryStringParameters,
} from 'aws-lambda';
import type { PRExecution } from '../shared/types';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EXECUTION_ENTITY_TYPE = 'execution';
const BY_REPO_INDEX = 'ByRepo';
const BY_REPO_PR_INDEX = 'ByRepoPr';
const BY_TIMESTAMP_INDEX = 'ByTimestamp';

class BadRequestError extends Error {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

type QueryParams = APIGatewayProxyEventQueryStringParameters;

function decodeNextToken(
  nextToken?: string | null
): Record<string, NativeAttributeValue> | undefined {
  if (!nextToken) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(nextToken, 'base64').toString());

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestError('Invalid nextToken');
    }

    return parsed as Record<string, NativeAttributeValue>;
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }

    throw new BadRequestError('Invalid nextToken');
  }
}

function getExecutionsTableName(): string {
  return process.env.EXECUTIONS_TABLE_NAME || 'pullmint-pr-executions';
}

function isAuthorized(event: APIGatewayProxyEvent): boolean {
  const authToken = process.env.DASHBOARD_AUTH_TOKEN;
  if (!authToken) {
    return true;
  }

  const headerValue = event.headers?.Authorization || event.headers?.authorization;
  if (!headerValue) {
    return false;
  }

  const token = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  return token === authToken;
}

/**
 * Dashboard API Handler
 * Provides REST endpoints for querying PR execution history
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log('Dashboard API request:', {
    path: event.path,
    method: event.httpMethod,
    queryParams: event.queryStringParameters,
  });

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
  };

  try {
    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: '',
      };
    }

    // Only support GET requests
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    if (!isAuthorized(event)) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Route requests
    const path = event.path;

    // GET /dashboard/executions/:executionId
    if (path.match(/^\/dashboard\/executions\/[a-zA-Z0-9-]+$/)) {
      const executionId = path.split('/').pop()!;
      return await getExecution(executionId, corsHeaders);
    }

    // GET /dashboard/repos/:owner/:repo/prs/:number
    if (path.match(/^\/dashboard\/repos\/[^/]+\/[^/]+\/prs\/\d+$/)) {
      const parts = path.split('/');
      const owner = parts[3];
      const repo = parts[4];
      const prNumber = parseInt(parts[6], 10);
      const repoFullName = `${owner}/${repo}`;
      return await getExecutionsByPR(
        repoFullName,
        prNumber,
        event.queryStringParameters,
        corsHeaders
      );
    }

    // GET /dashboard/executions
    if (path === '/dashboard/executions') {
      return await listExecutions(event.queryStringParameters, corsHeaders);
    }

    // Not found
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return {
        statusCode: error.statusCode,
        headers: corsHeaders,
        body: JSON.stringify({ error: error.message }),
      };
    }

    console.error('Dashboard API error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

/**
 * Get a specific execution by ID
 */
async function getExecution(
  executionId: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({
      TableName: getExecutionsTableName(),
      Key: { executionId },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Execution not found' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Item as PRExecution),
  };
}

/**
 * Get all executions for a specific PR
 */
async function getExecutionsByPR(
  repoFullName: string,
  prNumber: number,
  queryParams: QueryParams | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const limit = Math.min(parseInt(queryParams?.limit || `${DEFAULT_LIMIT}`, 10), MAX_LIMIT);

  const repoPrKey = `${repoFullName}#${prNumber}`;

  // Query using GSI (ByRepoPr) with repo+PR key
  const result = await docClient.send(
    new QueryCommand({
      TableName: getExecutionsTableName(),
      IndexName: BY_REPO_PR_INDEX,
      KeyConditionExpression: 'repoPrKey = :repoPrKey',
      ExpressionAttributeValues: {
        ':repoPrKey': repoPrKey,
      },
      Limit: limit,
      ScanIndexForward: false, // Latest first
      ExclusiveStartKey: decodeNextToken(queryParams?.nextToken),
    })
  );

  const executions = (result.Items || []) as PRExecution[];

  const response: {
    executions: PRExecution[];
    nextToken?: string;
    count: number;
  } = {
    executions,
    count: executions.length,
  };

  if (result.LastEvaluatedKey) {
    response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(response),
  };
}

/**
 * List executions with optional filtering
 */
async function listExecutions(
  queryParams: QueryParams | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const limit = Math.min(parseInt(queryParams?.limit || `${DEFAULT_LIMIT}`, 10), MAX_LIMIT);
  const repo = queryParams?.repo;
  const status = queryParams?.status;

  let result;

  if (repo) {
    // Query by repo using GSI
    const queryCommand = new QueryCommand({
      TableName: getExecutionsTableName(),
      IndexName: BY_REPO_INDEX,
      KeyConditionExpression: 'repoFullName = :repo',
      ExpressionAttributeValues: {
        ':repo': repo,
      },
      Limit: limit,
      ScanIndexForward: false, // Latest first
      ExclusiveStartKey: decodeNextToken(queryParams?.nextToken),
    });

    // Add status filter if provided
    if (status) {
      queryCommand.input.FilterExpression = '#status = :status';
      queryCommand.input.ExpressionAttributeNames = { '#status': 'status' };
      queryCommand.input.ExpressionAttributeValues = {
        ...queryCommand.input.ExpressionAttributeValues,
        ':status': status,
      };
    }

    result = await docClient.send(queryCommand);
  } else {
    // Query all executions by timestamp using GSI
    const queryCommand = new QueryCommand({
      TableName: getExecutionsTableName(),
      IndexName: BY_TIMESTAMP_INDEX,
      KeyConditionExpression: 'entityType = :entityType',
      ExpressionAttributeValues: {
        ':entityType': EXECUTION_ENTITY_TYPE,
      },
      Limit: limit,
      ScanIndexForward: false, // Latest first
      ExclusiveStartKey: decodeNextToken(queryParams?.nextToken),
    });

    // Add status filter if provided
    if (status) {
      queryCommand.input.FilterExpression = '#status = :status';
      queryCommand.input.ExpressionAttributeNames = { '#status': 'status' };
      queryCommand.input.ExpressionAttributeValues = {
        ...queryCommand.input.ExpressionAttributeValues,
        ':status': status,
      };
    }

    result = await docClient.send(queryCommand);
  }

  const executions = (result.Items || []) as PRExecution[];

  // Sort by timestamp descending (latest first)
  executions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const response: {
    executions: PRExecution[];
    nextToken?: string;
    count: number;
  } = {
    executions,
    count: executions.length,
  };

  if (result.LastEvaluatedKey) {
    response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(response),
  };
}
