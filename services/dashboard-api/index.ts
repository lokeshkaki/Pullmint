import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  APIGatewayProxyEventQueryStringParameters,
} from 'aws-lambda';
import type { PRExecution, RepoRegistryRecord } from '../shared/types';
import { getItem, updateItem } from '../shared/dynamodb';
import { publishEvent } from '../shared/eventbridge';
import { addTraceAnnotations } from '../shared/tracer';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EXECUTION_ENTITY_TYPE = 'execution';
const BY_REPO_INDEX = 'ByRepo';
const BY_REPO_PR_INDEX = 'ByRepoPr';
const BY_TIMESTAMP_INDEX = 'ByTimestamp';
const STATUS_DEPLOYED_AT_INDEX = 'StatusDeployedAtIndex';

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

function getCalibrationTableName(): string {
  return process.env.CALIBRATION_TABLE_NAME || '';
}

function getDedupTableName(): string {
  return process.env.DEDUP_TABLE_NAME || '';
}

function getRepoRegistryTableName(): string {
  return process.env.REPO_REGISTRY_TABLE_NAME || '';
}

function getEventBusName(): string {
  return process.env.EVENT_BUS_NAME || 'pullmint-bus';
}

function isAuthorized(event: APIGatewayProxyEvent): boolean {
  const authToken = process.env.DASHBOARD_AUTH_TOKEN;
  if (!authToken) {
    // Deny all requests when token is not configured — safe-by-default
    console.error('DASHBOARD_AUTH_TOKEN not configured — denying all requests');
    return false;
  }

  const headerValue = event.headers?.Authorization || event.headers?.authorization;
  if (!headerValue) {
    return false;
  }

  const token = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  return token === authToken;
}

function getCorsOrigin(requestOrigin: string | undefined): string {
  const allowedOrigins = (process.env.DASHBOARD_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  if (!requestOrigin || allowedOrigins.length === 0) return '';
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : '';
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
  addTraceAnnotations({ path: event.path });

  const requestOrigin = event.headers?.origin || event.headers?.Origin;
  const corsHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(requestOrigin),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
    Vary: 'Origin',
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

    // Only support GET requests, except POST on the re-evaluate path
    if (
      event.httpMethod !== 'GET' &&
      !event.path?.endsWith('/re-evaluate') &&
      !event.path?.endsWith('/reindex')
    ) {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    if (!process.env.DASHBOARD_AUTH_TOKEN) {
      return {
        statusCode: 503,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Service unavailable: authentication not configured' }),
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

    // GET /dashboard/board
    if (path === '/dashboard/board') {
      return await getBoard(corsHeaders);
    }

    // GET /dashboard/executions/:id/checkpoints
    if (path.match(/^\/dashboard\/executions\/[a-zA-Z0-9-]+\/checkpoints$/)) {
      const executionId = path.split('/')[3];
      return await getExecutionCheckpoints(executionId, corsHeaders);
    }

    // POST /dashboard/executions/:id/re-evaluate
    if (
      event.httpMethod === 'POST' &&
      path.match(/^\/dashboard\/executions\/[a-zA-Z0-9-]+\/re-evaluate$/)
    ) {
      const executionId = path.split('/')[3];
      return await reEvaluateExecution(executionId, event.body, corsHeaders);
    }

    // GET /dashboard/executions/:executionId
    if (path.match(/^\/dashboard\/executions\/[a-zA-Z0-9-]+$/)) {
      const executionId = path.split('/').pop()!;
      return await getExecution(executionId, corsHeaders);
    }

    // POST /dashboard/repos/:owner/:repo/reindex
    if (event.httpMethod === 'POST' && path.match(/^\/dashboard\/repos\/[^/]+\/[^/]+\/reindex$/)) {
      const parts = path.split('/');
      const owner = parts[3];
      const repo = parts[4];
      const repoFullName = `${owner}/${repo}`;
      const existing = await getItem<RepoRegistryRecord>(getRepoRegistryTableName(), {
        repoFullName,
      });
      if (!existing) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Repo not registered' }),
        };
      }
      await updateItem(
        getRepoRegistryTableName(),
        { repoFullName },
        {
          indexingStatus: 'pending',
          pendingBatches: 0,
        }
      );
      await publishEvent(getEventBusName(), 'pullmint.github', 'repo.onboarding.requested', {
        repoFullName,
      });
      return {
        statusCode: 202,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'Reindex triggered', repoFullName }),
      };
    }

    // GET /dashboard/repos/:owner/:repo (must come after /reindex and before /prs)
    if (event.httpMethod === 'GET' && path.match(/^\/dashboard\/repos\/[^/]+\/[^/]+$/)) {
      const parts = path.split('/');
      const owner = parts[3];
      const repo = parts[4];
      const repoFullName = `${owner}/${repo}`;
      const item = await getItem<RepoRegistryRecord>(getRepoRegistryTableName(), { repoFullName });
      if (!item) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Repo not registered' }),
        };
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(item),
      };
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

    // GET /dashboard/calibration — must come before /calibration/:repo
    if (path === '/dashboard/calibration') {
      return await listCalibration(corsHeaders);
    }

    // GET /dashboard/calibration/:owner/:repo
    if (path.match(/^\/dashboard\/calibration\/[^/]+\/[^/]+$/)) {
      const parts = path.split('/');
      const repoFullName = `${parts[3]}/${parts[4]}`;
      return await getCalibrationByRepo(repoFullName, corsHeaders);
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

/**
 * GET /dashboard/board
 * Returns all active executions grouped by status for the kanban board.
 */
async function getBoard(headers: Record<string, string>): Promise<APIGatewayProxyResult> {
  const activeStatuses = ['analyzing', 'completed', 'deploying', 'monitoring'];
  const recentTerminalStatuses = ['confirmed', 'rolled-back'];
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const tableName = getExecutionsTableName();

  const activeQueries = activeStatuses.map((status) =>
    docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: STATUS_DEPLOYED_AT_INDEX,
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      })
    )
  );

  const terminalQueries = recentTerminalStatuses.map((status) =>
    docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: STATUS_DEPLOYED_AT_INDEX,
        KeyConditionExpression: '#s = :s AND deploymentStartedAt >= :since',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status, ':since': since24h },
      })
    )
  );

  const results = await Promise.all([...activeQueries, ...terminalQueries]);
  const allStatuses = [...activeStatuses, ...recentTerminalStatuses];

  const board: Record<
    string,
    {
      executionId: string;
      repoFullName: string;
      prNumber: number;
      title?: string;
      author?: string;
      riskScore?: number;
      confidenceScore?: number;
      currentCheckpoint?: string;
      deploymentStartedAt?: number;
      timeInCurrentStateMs?: number;
    }[]
  > = {};

  results.forEach((result, i) => {
    const status = allStatuses[i];
    board[status] = (result.Items ?? []).map((item) => {
      const checkpoints = item.checkpoints as { type: string }[] | undefined;
      return {
        executionId: item.executionId as string,
        repoFullName: item.repoFullName as string,
        prNumber: item.prNumber as number,
        title: item.title as string | undefined,
        author: item.author as string | undefined,
        riskScore: item.riskScore as number | undefined,
        confidenceScore: item.confidenceScore as number | undefined,
        currentCheckpoint: checkpoints?.at(-1)?.type,
        deploymentStartedAt: item.deploymentStartedAt as number | undefined,
        timeInCurrentStateMs: item.deploymentStartedAt
          ? Date.now() - (item.deploymentStartedAt as number)
          : undefined,
      };
    });
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ board }),
  };
}

/**
 * GET /dashboard/executions/:id/checkpoints
 * Returns the full checkpoint history, signals, and repo context for an execution.
 */
async function getExecutionCheckpoints(
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

  const item = result.Item as PRExecution;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      executionId,
      checkpoints: item.checkpoints ?? [],
      signalsReceived: item.signalsReceived ?? {},
      repoContext: item.repoContext ?? null,
      calibrationApplied: item.calibrationApplied ?? null,
    }),
  };
}

/**
 * GET /dashboard/calibration
 * Scans calibration table for all repos, sorted by calibrationFactor descending.
 * MVP: no pagination.
 */
async function listCalibration(headers: Record<string, string>): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: getCalibrationTableName(),
    })
  );

  const repos = (result.Items ?? []).sort(
    (a, b) => ((b.calibrationFactor as number) ?? 1) - ((a.calibrationFactor as number) ?? 1)
  );

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ repos }),
  };
}

/**
 * GET /dashboard/calibration/:owner/:repo
 * Returns the calibration record for a specific repo.
 */
async function getCalibrationByRepo(
  repoFullName: string,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({
      TableName: getCalibrationTableName(),
      Key: { repoFullName },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Calibration record not found' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result.Item),
  };
}

/**
 * POST /dashboard/executions/:id/re-evaluate
 * Rate-limited (1 per 2 min). Logs override to overrideHistory.
 * MVP: returns 202 only — does not publish a re-evaluation event yet.
 */
async function reEvaluateExecution(
  executionId: string,
  rawBody: string | null,
  headers: Record<string, string>
): Promise<APIGatewayProxyResult> {
  const dedupKey = `reeval:${executionId}`;

  // Rate-limit check
  const existing = await docClient.send(
    new GetCommand({
      TableName: getDedupTableName(),
      Key: { deliveryId: dedupKey },
    })
  );

  if (existing.Item) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Rate limit exceeded. Try again in 2 minutes.' }),
    };
  }

  // Write rate-limit record (TTL: 2 minutes from now, in epoch seconds)
  const ttl = Math.floor(Date.now() / 1000) + 120;
  await docClient.send(
    new PutCommand({
      TableName: getDedupTableName(),
      Item: { deliveryId: dedupKey, ttl },
    })
  );

  // Parse justification from request body (optional)
  let justification = '';
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (typeof parsed.justification === 'string') {
        justification = parsed.justification;
      }
    } catch {
      // Ignore JSON parse errors — justification is optional
    }
  }

  // Append to overrideHistory on execution record
  const overrideEntry = { overriddenAt: Date.now(), justification };
  await docClient.send(
    new UpdateCommand({
      TableName: getExecutionsTableName(),
      Key: { executionId },
      UpdateExpression:
        'SET overrideHistory = list_append(if_not_exists(overrideHistory, :empty), :entry)',
      ExpressionAttributeValues: {
        ':empty': [],
        ':entry': [overrideEntry],
      },
    })
  );

  // TODO: publish re-evaluation event when on-demand checkpoint mechanism is defined

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ message: 'Re-evaluation logged' }),
  };
}
