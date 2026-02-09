import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../shared/secrets';
import { publishEvent } from '../shared/eventbridge';
import { updateItem } from '../shared/dynamodb';
import { verifyGitHubSignature, generateExecutionId, calculateTTL } from '../shared/utils';
import {
  GitHubPRPayload,
  GitHubDeploymentStatusPayload,
  PREvent,
  PRExecution,
} from '../shared/types';

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

    // 2. Parse event
    const eventType = event.headers['x-github-event'] || event.headers['X-GitHub-Event'];
    const payload = JSON.parse(event.body || '{}') as unknown;

    // 3. Filter relevant events
    if (eventType !== 'pull_request' && eventType !== 'deployment_status') {
      console.log(`Ignoring event type: ${eventType}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Event type ignored' }),
      };
    }

    // 4. Idempotency check (after event filtering to avoid unnecessary DynamoDB writes)
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

    // 5. Handle deployment status updates
    if (eventType === 'deployment_status') {
      const deploymentPayload = payload as GitHubDeploymentStatusPayload;
      const executionId = extractExecutionId(deploymentPayload.deployment.payload);

      if (!executionId) {
        console.log('Deployment status event missing executionId in payload');
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Deployment payload ignored' }),
        };
      }

      const deploymentState = deploymentPayload.deployment_status.state;
      const mappedStatus = mapDeploymentState(deploymentState);
      const deploymentUrl =
        deploymentPayload.deployment_status.environment_url ||
        deploymentPayload.deployment_status.log_url;

      await updateItem(
        EXECUTIONS_TABLE_NAME,
        { executionId },
        {
          status: mappedStatus,
          deploymentStatus: deploymentState,
          deploymentEnvironment: deploymentPayload.deployment.environment,
          deploymentId: deploymentPayload.deployment.id,
          deploymentUrl,
          deploymentUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Deployment status updated' }),
      };
    }

    const prPayload = payload as GitHubPRPayload;
    if (!['opened', 'synchronize', 'reopened'].includes(prPayload.action)) {
      console.log(`Ignoring PR action: ${prPayload.action}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'PR action ignored' }),
      };
    }

    // 6. Create PR event
    const prEvent: PREvent = {
      prNumber: prPayload.pull_request.number,
      repoFullName: prPayload.repository.full_name,
      headSha: prPayload.pull_request.head.sha,
      baseSha: prPayload.pull_request.base.sha,
      author: prPayload.pull_request.user.login,
      title: prPayload.pull_request.title,
      orgId: `org_${prPayload.repository.owner.id}`,
    };

    // 7. Create execution record
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

    // 8. Publish to EventBridge
    await publishEvent(EVENT_BUS_NAME, 'pullmint.github', `pr.${prPayload.action}`, {
      ...prEvent,
      executionId,
    });

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

function extractExecutionId(payload: Record<string, unknown> | string | undefined): string | null {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      return readExecutionId(parsed);
    } catch {
      return null;
    }
  }

  return readExecutionId(payload);
}

function readExecutionId(payload: Record<string, unknown>): string | null {
  const executionId = payload.executionId || payload.execution_id;
  return typeof executionId === 'string' ? executionId : null;
}

function mapDeploymentState(state: string): PRExecution['status'] {
  if (state === 'success') {
    return 'deployed';
  }
  if (state === 'failure' || state === 'error' || state === 'inactive') {
    return 'failed';
  }
  return 'deploying';
}
