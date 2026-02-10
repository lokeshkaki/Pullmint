import { EventBridgeHandler } from 'aws-lambda';
import { publishEvent } from '../shared/eventbridge';
import { updateItem } from '../shared/dynamodb';
import { DeploymentApprovedEvent, DeploymentStatusEvent } from '../shared/types';

type DeploymentOutcome = {
  status: 'deployed' | 'failed';
  message: string;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<FetchResponse>;

export const handler: EventBridgeHandler<
  'deployment_approved',
  DeploymentApprovedEvent,
  void
> = async (event): Promise<void> => {
  const detail = event.detail;
  const config = getDeploymentConfig();

  await updateItem(
    config.executionsTableName,
    { executionId: detail.executionId },
    {
      status: 'deploying',
      deploymentStatus: 'deploying',
      deploymentEnvironment: detail.deploymentEnvironment,
      deploymentStrategy: detail.deploymentStrategy,
      deploymentStartedAt: Date.now(),
      updatedAt: Date.now(),
    }
  );

  const outcome = await performDeployment(detail, config);

  await updateItem(
    config.executionsTableName,
    { executionId: detail.executionId },
    {
      status: outcome.status === 'deployed' ? 'deployed' : 'failed',
      deploymentStatus: outcome.status,
      deploymentEnvironment: detail.deploymentEnvironment,
      deploymentStrategy: detail.deploymentStrategy,
      deploymentMessage: outcome.message,
      deploymentCompletedAt: Date.now(),
      updatedAt: Date.now(),
    }
  );

  const statusEvent: DeploymentStatusEvent = {
    ...detail,
    deploymentStatus: outcome.status,
    message: outcome.message,
  };

  await publishEvent(
    config.eventBusName,
    'pullmint.orchestrator',
    'deployment.status',
    statusEvent as unknown as Record<string, unknown>
  );
};

async function performDeployment(
  detail: DeploymentApprovedEvent,
  config: DeploymentConfig
): Promise<DeploymentOutcome> {
  if (config.deploymentDelayMs > 0) {
    await delay(config.deploymentDelayMs);
  }

  if (!config.deploymentWebhookUrl) {
    return {
      status: 'failed',
      message: 'Deployment webhook URL is not configured',
    };
  }

  try {
    await postWithRetry(config.deploymentWebhookUrl, config, {
      executionId: detail.executionId,
      prNumber: detail.prNumber,
      repoFullName: detail.repoFullName,
      deploymentEnvironment: detail.deploymentEnvironment,
      deploymentStrategy: detail.deploymentStrategy,
      headSha: detail.headSha,
      baseSha: detail.baseSha,
      author: detail.author,
      title: detail.title,
      orgId: detail.orgId,
    });

    return {
      status: 'deployed',
      message: `Deployment succeeded for ${detail.repoFullName}`,
    };
  } catch (error) {
    const failureMessage = String(error);
    let rollbackMessage = '';

    if (config.rollbackWebhookUrl) {
      try {
        await postWithRetry(config.rollbackWebhookUrl, config, {
          executionId: detail.executionId,
          prNumber: detail.prNumber,
          repoFullName: detail.repoFullName,
          deploymentEnvironment: detail.deploymentEnvironment,
          deploymentStrategy: detail.deploymentStrategy,
          headSha: detail.headSha,
          baseSha: detail.baseSha,
          author: detail.author,
          title: detail.title,
          orgId: detail.orgId,
          reason: failureMessage,
        });
        rollbackMessage = ' Rollback triggered.';
      } catch (rollbackError) {
        const rollbackFailure = String(rollbackError);
        rollbackMessage = ` Rollback failed: ${rollbackFailure}.`;
      }
    }

    return {
      status: 'failed',
      message: `Deployment failed: ${failureMessage}.${rollbackMessage}`,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DeploymentConfig = {
  eventBusName: string;
  executionsTableName: string;
  deploymentDelayMs: number;
  deploymentWebhookUrl?: string;
  deploymentWebhookAuthToken?: string;
  deploymentWebhookTimeoutMs: number;
  deploymentWebhookRetries: number;
  rollbackWebhookUrl?: string;
};

function getDeploymentConfig(): DeploymentConfig {
  const eventBusName = process.env.EVENT_BUS_NAME;
  const executionsTableName = process.env.EXECUTIONS_TABLE_NAME;

  if (!eventBusName) {
    throw new Error('EVENT_BUS_NAME is required');
  }

  if (!executionsTableName) {
    throw new Error('EXECUTIONS_TABLE_NAME is required');
  }

  return {
    eventBusName,
    executionsTableName,
    deploymentDelayMs: Number(process.env.DEPLOYMENT_DELAY_MS || '0'),
    deploymentWebhookUrl: process.env.DEPLOYMENT_WEBHOOK_URL,
    deploymentWebhookAuthToken: process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN,
    deploymentWebhookTimeoutMs: Number(process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS || '10000'),
    deploymentWebhookRetries: Number(process.env.DEPLOYMENT_WEBHOOK_RETRIES || '2'),
    rollbackWebhookUrl: process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL,
  };
}

async function postWithRetry(
  url: string,
  config: DeploymentConfig,
  payload: Record<string, unknown>
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.deploymentWebhookRetries; attempt += 1) {
    try {
      await postJson(url, config, payload);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.deploymentWebhookRetries) {
        await delay(500 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error('Deployment webhook failed');
}

async function postJson(
  url: string,
  config: DeploymentConfig,
  payload: Record<string, unknown>
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.deploymentWebhookAuthToken) {
    headers.Authorization = `Bearer ${config.deploymentWebhookAuthToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.deploymentWebhookTimeoutMs);

  try {
    const fetchFn = (globalThis as { fetch?: FetchFn }).fetch;
    if (!fetchFn) {
      throw new Error('Fetch is not available in this runtime');
    }

    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`Deployment webhook failed with ${response.status}: ${responseText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
