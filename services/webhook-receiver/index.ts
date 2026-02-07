import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../shared/secrets';
import { publishEvent } from '../shared/eventbridge';
import { verifyGitHubSignature, generateExecutionId, calculateTTL } from '../shared/utils';
import { GitHubPRPayload, PREvent, PRExecution } from '../shared/types';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const WEBHOOK_SECRET_ARN = process.env.WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.DEDUP_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;

/**
 * GitHub Webhook Handler
 * Receives webhook events, validates signatures, and routes to EventBridge
 */
export const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  try {
    // 1. Verify GitHub signature
    const signature = event.headers['x-hub-signature-256'] || event.headers['X-Hub-Signature-256'];
    const webhookSecret = await getSecret(WEBHOOK_SECRET_ARN);
    
    if (!verifyGitHubSignature(event.body || '', signature, webhookSecret)) {
      console.error('Invalid GitHub signature');
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }

    // 2. Idempotency check
    const deliveryId = event.headers['x-github-delivery'] || event.headers['X-GitHub-Delivery'];
    if (!deliveryId) {
      console.error('Missing delivery ID');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing delivery ID' }),
      };
    }

    try {
      await docClient.send(
        new PutCommand({
          TableName: DEDUP_TABLE_NAME,
          Item: {
            deliveryId,
            processedAt: Date.now(),
            ttl: calculateTTL(86400), // 24 hours
          },
          ConditionExpression: 'attribute_not_exists(deliveryId)',
        })
      );
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        console.log(`Duplicate delivery: ${deliveryId}`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Already processed' }),
        };
      }
      throw error;
    }

    // 3. Parse event
    const eventType = event.headers['x-github-event'] || event.headers['X-GitHub-Event'];
    const payload: GitHubPRPayload = JSON.parse(event.body || '{}');

    // 4. Filter relevant events
    if (eventType !== 'pull_request') {
      console.log(`Ignoring event type: ${eventType}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Event type ignored' }),
      };
    }

    if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) {
      console.log(`Ignoring PR action: ${payload.action}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'PR action ignored' }),
      };
    }

    // 5. Create PR event
    const prEvent: PREvent = {
      prNumber: payload.pull_request.number,
      repoFullName: payload.repository.full_name,
      headSha: payload.pull_request.head.sha,
      baseSha: payload.pull_request.base.sha,
      author: payload.pull_request.user.login,
      title: payload.pull_request.title,
      orgId: `org_${payload.repository.owner.id}`,
    };

    // 6. Create execution record
    const executionId = generateExecutionId(
      prEvent.repoFullName,
      prEvent.prNumber,
      prEvent.headSha
    );

    const execution: PRExecution = {
      executionId,
      repoFullName: prEvent.repoFullName,
      prNumber: prEvent.prNumber,
      headSha: prEvent.headSha,
      status: 'pending',
      timestamp: Date.now(),
    };

    await docClient.send(
      new PutCommand({
        TableName: EXECUTIONS_TABLE_NAME,
        Item: execution,
      })
    );

    // 7. Publish to EventBridge
    await publishEvent(
      EVENT_BUS_NAME,
      'pullmint.github',
      `pr.${payload.action}`,
      {
        ...prEvent,
        executionId,
      }
    );

    console.log(`Published event for PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);

    return {
      statusCode: 202,
      body: JSON.stringify({
        message: 'Event accepted',
        executionId,
      }),
    };
  } catch (error) {
    console.error('Webhook processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
      }),
    };
  }
};
