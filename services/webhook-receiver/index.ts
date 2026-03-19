import { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../shared/secrets';
import { publishEvent } from '../shared/eventbridge';
import { getItem, appendToList } from '../shared/dynamodb';
import { verifyGitHubSignature, generateExecutionId, calculateTTL } from '../shared/utils';
import { createStructuredError } from '../shared/error-handling';
import { addTraceAnnotations } from '../shared/tracer';
import {
  GitHubPRPayload,
  GitHubDeploymentStatusPayload,
  PREvent,
  PRExecution,
  DeploymentStatusEvent,
} from '../shared/types';
import type { RepoRegistryRecord, PRMergedEvent } from '../shared/types';

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const payload: unknown = JSON.parse(event.body || '{}');

    // 3. Filter relevant events
    const ACCEPTED_EVENT_TYPES = new Set([
      'pull_request',
      'deployment_status',
      'installation',
      'installation_repositories',
    ]);
    if (!ACCEPTED_EVENT_TYPES.has(eventType ?? '')) {
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

    // Handle installation events (GitHub App install / repo added)
    if (eventType === 'installation' || eventType === 'installation_repositories') {
      const instPayload = payload as {
        action: string;
        installation: { id: number };
        repositories?: Array<{ full_name: string }>;
        repositories_added?: Array<{ full_name: string }>;
      };

      // Only process creation/addition — ignore deleted, suspend, etc.
      const isRelevantAction =
        (eventType === 'installation' && instPayload.action === 'created') ||
        (eventType === 'installation_repositories' && instPayload.action === 'added');

      if (!isRelevantAction) {
        console.log(`Ignoring installation action: ${instPayload.action}`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Installation action ignored' }),
        };
      }

      const repos =
        eventType === 'installation'
          ? (instPayload.repositories ?? [])
          : (instPayload.repositories_added ?? []);

      await Promise.all(
        repos.map((r) =>
          publishEvent(EVENT_BUS_NAME, 'pullmint.github', 'repo.onboarding.requested', {
            repoFullName: r.full_name,
            installationId: instPayload.installation.id,
          })
        )
      );
      return { statusCode: 202, body: JSON.stringify({ message: 'Onboarding triggered' }) };
    }

    if (eventType === 'pull_request') {
      const prPayload = payload as GitHubPRPayload;

      if (!['opened', 'synchronize', 'reopened', 'closed'].includes(prPayload.action)) {
        console.log(`Ignoring PR action: ${prPayload.action}`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'PR action ignored' }),
        };
      }

      // Handle merged PR
      if (prPayload.action === 'closed') {
        if (!prPayload.pull_request.merged) {
          return { statusCode: 200, body: JSON.stringify({ message: 'PR closed without merge' }) };
        }
        // Best-effort executionId lookup via GSI
        let executionId: string | undefined;
        try {
          const gsiResult = await docClient.send(
            new QueryCommand({
              TableName: EXECUTIONS_TABLE_NAME,
              IndexName: 'ByRepoPr',
              KeyConditionExpression: 'repoPrKey = :key',
              ExpressionAttributeValues: {
                ':key': `${prPayload.repository.full_name}#${prPayload.pull_request.number}`,
              },
              Limit: 1,
            })
          );
          executionId = (gsiResult.Items?.[0] as { executionId?: string })?.executionId;
        } catch {
          /* best effort */
        }

        const mergedEvent: PRMergedEvent = {
          repoFullName: prPayload.repository.full_name,
          prNumber: prPayload.pull_request.number,
          headSha: prPayload.pull_request.merge_commit_sha ?? prPayload.pull_request.head.sha,
          author: prPayload.pull_request.user.login,
          mergedAt: Date.now(),
          executionId,
        };
        await publishEvent(
          EVENT_BUS_NAME,
          'pullmint.github',
          'pr.merged',
          mergedEvent as unknown as Record<string, unknown>
        );
        return { statusCode: 202, body: JSON.stringify({ message: 'Merge event published' }) };
      }

      // 5. Create PR event
      const prEvent: PREvent = {
        prNumber: prPayload.pull_request.number,
        repoFullName: prPayload.repository.full_name,
        headSha: prPayload.pull_request.head.sha,
        baseSha: prPayload.pull_request.base.sha,
        author: prPayload.pull_request.user.login,
        title: prPayload.pull_request.title,
        orgId: `org_${prPayload.repository.owner.id}`,
      };

      // Check if repo is indexed; queue execution if not
      const repoRegistryTable = process.env.REPO_REGISTRY_TABLE_NAME ?? '';
      if (repoRegistryTable) {
        const registry = await getItem<RepoRegistryRecord>(repoRegistryTable, {
          repoFullName: prEvent.repoFullName,
        });
        if (registry && registry.indexingStatus !== 'indexed') {
          const queuedExecutionId = generateExecutionId(
            prEvent.repoFullName,
            prEvent.prNumber,
            prEvent.headSha
          );
          const queuedExecution: PRExecution = {
            executionId: queuedExecutionId,
            repoFullName: prEvent.repoFullName,
            repoPrKey: `${prEvent.repoFullName}#${prEvent.prNumber}`,
            prNumber: prEvent.prNumber,
            headSha: prEvent.headSha,
            status: 'pending',
            timestamp: Date.now(),
            entityType: 'execution',
          };
          try {
            await docClient.send(
              new PutCommand({
                TableName: EXECUTIONS_TABLE_NAME,
                Item: queuedExecution,
                ConditionExpression: 'attribute_not_exists(executionId)',
              })
            );
          } catch (err) {
            if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
              return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Already processing' }),
              };
            }
            throw err;
          }
          await appendToList(
            repoRegistryTable,
            { repoFullName: prEvent.repoFullName },
            'queuedExecutionIds',
            queuedExecutionId
          );
          return {
            statusCode: 202,
            body: JSON.stringify({
              message: 'Queued — repo indexing in progress',
              executionId: queuedExecutionId,
            }),
          };
        }
      }

      // 6. Create execution record
      const executionId = generateExecutionId(
        prEvent.repoFullName,
        prEvent.prNumber,
        prEvent.headSha
      );
      addTraceAnnotations({ executionId, prNumber: prEvent.prNumber });

      const execution: PRExecution = {
        executionId,
        repoFullName: prEvent.repoFullName,
        repoPrKey: `${prEvent.repoFullName}#${prEvent.prNumber}`,
        prNumber: prEvent.prNumber,
        headSha: prEvent.headSha,
        status: 'pending',
        timestamp: Date.now(),
        entityType: 'execution',
      };

      try {
        await docClient.send(
          new PutCommand({
            TableName: EXECUTIONS_TABLE_NAME,
            Item: execution,
            ConditionExpression: 'attribute_not_exists(executionId)',
          })
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
          console.warn(
            `Execution record already exists for ${executionId} — skipping duplicate write`
          );
          return { statusCode: 200, body: JSON.stringify({ message: 'Already processing' }) };
        }
        throw err;
      }

      // 7. Publish to EventBridge
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
    }

    const deploymentPayload = payload as GitHubDeploymentStatusPayload;
    const deploymentDetail = buildDeploymentStatusDetail(deploymentPayload);

    if (!deploymentDetail) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Deployment status ignored' }),
      };
    }

    await publishEvent(
      EVENT_BUS_NAME,
      'pullmint.github',
      'deployment.status',
      deploymentDetail as unknown as Record<string, unknown>
    );

    return {
      statusCode: 202,
      body: JSON.stringify({ message: 'Deployment status accepted' }),
    };
  } catch (error) {
    // Structured error logging for CloudWatch
    const structuredError = createStructuredError(
      error instanceof Error ? error : new Error('Unknown error'),
      {
        context: 'webhook-receiver',
        path: event.path,
        eventType: event.headers['x-github-event'] || event.headers['X-GitHub-Event'],
      }
    );

    console.error('Webhook processing error:', JSON.stringify(structuredError));
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
      }),
    };
  }
};

function buildDeploymentStatusDetail(
  payload: GitHubDeploymentStatusPayload
): DeploymentStatusEvent | null {
  const deploymentPayload = payload.deployment.payload || {};
  const executionId = deploymentPayload.executionId;
  const prNumber = deploymentPayload.prNumber;
  const repoFullName = deploymentPayload.repoFullName || payload.repository.full_name;

  if (!executionId || !prNumber) {
    console.log('Deployment status missing executionId or prNumber, ignoring.');
    return null;
  }

  const deploymentStatus = mapDeploymentStatus(payload.deployment_status.state);

  // Ignore inactive deployments
  if (deploymentStatus === null) {
    console.log('Deployment status is inactive, ignoring.');
    return null;
  }

  const deploymentEnvironment = payload.deployment.environment;
  const deploymentStrategy = deploymentPayload.deploymentStrategy || 'deployment';

  return {
    executionId,
    prNumber,
    repoFullName,
    headSha: payload.deployment.sha,
    baseSha: deploymentPayload.baseSha || '',
    author: deploymentPayload.author || 'unknown',
    title: deploymentPayload.title || 'Deployment update',
    orgId: deploymentPayload.orgId || `org_${payload.repository.owner.id}`,
    deploymentEnvironment,
    deploymentStrategy,
    deploymentStatus,
    message: payload.deployment_status.description,
  };
}

function mapDeploymentStatus(
  state: GitHubDeploymentStatusPayload['deployment_status']['state']
): 'deploying' | 'deployed' | 'failed' | null {
  if (state === 'success') {
    return 'deployed';
  }

  if (state === 'queued' || state === 'in_progress') {
    return 'deploying';
  }

  // Inactive status indicates deployment was deactivated, not failed
  if (state === 'inactive') {
    return null;
  }

  // failure, error, or other states map to failed
  return 'failed';
}
