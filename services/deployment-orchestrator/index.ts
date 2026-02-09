import { EventBridgeHandler } from 'aws-lambda';
import { publishEvent } from '../shared/eventbridge';
import { updateItem } from '../shared/dynamodb';
import { DeploymentApprovedEvent, DeploymentStatusEvent } from '../shared/types';

type DeploymentOutcome = {
  status: 'deployed' | 'failed';
  message: string;
};

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

  if (config.deploymentResult === 'fail' || config.deploymentResult === 'failed') {
    return {
      status: 'failed',
      message: `Deployment failed for ${detail.repoFullName}`,
    };
  }

  return {
    status: 'deployed',
    message: `Deployment succeeded for ${detail.repoFullName}`,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DeploymentConfig = {
  eventBusName: string;
  executionsTableName: string;
  deploymentResult: string;
  deploymentDelayMs: number;
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
    deploymentResult: process.env.DEPLOYMENT_RESULT || 'success',
    deploymentDelayMs: Number(process.env.DEPLOYMENT_DELAY_MS || '0'),
  };
}
