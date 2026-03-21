import { EventBridgeHandler } from 'aws-lambda';
import { publishEvent } from '../shared/eventbridge';
import { getItem, updateItem } from '../shared/dynamodb';
import { createStructuredError } from '../shared/error-handling';
import { getSecret } from '../shared/secrets';
import { addTraceAnnotations } from '../shared/tracer';
import { evaluateRisk } from '../shared/risk-evaluator';
import {
  DeploymentApprovedEvent,
  DeploymentStatusEvent,
  Signal,
  CheckpointRecord,
} from '../shared/types';

const DEPLOYMENT_THRESHOLD = 40;

type DeploymentOutcome = {
  status: 'deployed' | 'failed';
  message: string;
  rollbackStatus: 'triggered' | 'failed' | 'not-configured';
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
  addTraceAnnotations({ executionId: detail.executionId, prNumber: detail.prNumber });
  const config = await getDeploymentConfig();
  let deployingStatusSet = false;

  try {
    // Idempotency guard: if a prior invocation already started deploying, skip to avoid double-deployment
    const existing = await getItem<{ deploymentStartedAt?: number }>(config.executionsTableName, {
      executionId: detail.executionId,
    });
    if (existing?.deploymentStartedAt) {
      console.warn(
        `Deployment already started for ${detail.executionId} — skipping duplicate invocation`
      );
      return;
    }

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
    deployingStatusSet = true;

    // Checkpoint 2: wait for late signals then re-evaluate risk before deploying
    const {
      score: checkpoint2Score,
      checkpoint: checkpoint2,
      priorCheckpoints,
    } = await runCheckpoint2(detail, config);

    if (checkpoint2Score >= DEPLOYMENT_THRESHOLD) {
      await updateItem(
        config.executionsTableName,
        { executionId: detail.executionId },
        {
          status: 'deployment-blocked',
          checkpoints: [...priorCheckpoints, checkpoint2],
          deploymentBlockedAt: Date.now(),
          updatedAt: Date.now(),
        }
      );
      deployingStatusSet = false;
      return;
    }

    const outcome = await performDeployment(detail, config);

    await updateItem(
      config.executionsTableName,
      { executionId: detail.executionId },
      {
        status: outcome.status === 'deployed' ? 'monitoring' : 'failed',
        deploymentStatus: outcome.status,
        deploymentEnvironment: detail.deploymentEnvironment,
        deploymentStrategy: detail.deploymentStrategy,
        deploymentMessage: outcome.message,
        rollbackStatus: outcome.rollbackStatus,
        checkpoints: [...priorCheckpoints, checkpoint2],
        deploymentCompletedAt: Date.now(),
        updatedAt: Date.now(),
      }
    );
    deployingStatusSet = false;

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
  } catch (error) {
    // Structured error logging for CloudWatch
    const structuredError = createStructuredError(
      error instanceof Error ? error : new Error('Unknown error'),
      {
        context: 'deployment-orchestrator',
        executionId: event.detail?.executionId,
        repoFullName: event.detail?.repoFullName,
      }
    );

    console.error('Deployment orchestration error:', JSON.stringify(structuredError));
    throw error;
  } finally {
    if (deployingStatusSet) {
      // Unhandled exception occurred after 'deploying' was set — force a terminal status
      try {
        await updateItem(
          config.executionsTableName,
          { executionId: detail.executionId },
          {
            status: 'failed',
            deploymentStatus: 'failed',
            deploymentMessage:
              'Unhandled error during deployment — status recovered by finally block',
            deploymentCompletedAt: Date.now(),
            updatedAt: Date.now(),
          }
        );
      } catch (finallyError) {
        console.error('CRITICAL: Failed to write terminal status in finally block', finallyError);
      }
    }
  }
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
      rollbackStatus: 'not-configured',
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
      rollbackStatus: 'not-configured',
    };
  } catch (error) {
    const failureMessage = String(error);
    let rollbackStatus: 'triggered' | 'failed' | 'not-configured' = 'not-configured';
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
        rollbackStatus = 'triggered';
        rollbackMessage = ' Rollback triggered.';
      } catch (rollbackError) {
        rollbackStatus = 'failed';
        const rollbackFailure = String(rollbackError);
        rollbackMessage = ` Rollback failed: ${rollbackFailure}.`;
      }
    }

    return {
      status: 'failed',
      message: `Deployment failed: ${failureMessage}.${rollbackMessage}`,
      rollbackStatus,
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
  deploymentWebhookAuthToken: string;
  deploymentWebhookTimeoutMs: number;
  deploymentWebhookRetries: number;
  rollbackWebhookUrl?: string;
  calibrationTableName: string;
  checkpoint2WaitMs: number;
};

async function getWebhookConfig(): Promise<{ url: string; token: string }> {
  const secretArn = process.env.DEPLOYMENT_WEBHOOK_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DEPLOYMENT_WEBHOOK_SECRET_ARN is required but not set');
  }
  const secretValue = await getSecret(secretArn);
  const parsed = JSON.parse(secretValue) as { url: string; token: string };
  return { url: parsed.url, token: parsed.token };
}

async function getDeploymentConfig(): Promise<DeploymentConfig> {
  const eventBusName = process.env.EVENT_BUS_NAME;
  const executionsTableName = process.env.EXECUTIONS_TABLE_NAME;

  if (!eventBusName) {
    throw new Error('EVENT_BUS_NAME is required');
  }

  if (!executionsTableName) {
    throw new Error('EXECUTIONS_TABLE_NAME is required');
  }

  const webhookConfig = await getWebhookConfig();

  return {
    eventBusName,
    executionsTableName,
    deploymentDelayMs: Number(process.env.DEPLOYMENT_DELAY_MS || '0'),
    deploymentWebhookUrl: webhookConfig.url || process.env.DEPLOYMENT_WEBHOOK_URL,
    deploymentWebhookAuthToken: webhookConfig.token,
    deploymentWebhookTimeoutMs: Number(process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS || '10000'),
    deploymentWebhookRetries: Number(process.env.DEPLOYMENT_WEBHOOK_RETRIES || '2'),
    rollbackWebhookUrl: process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL,
    calibrationTableName: process.env.CALIBRATION_TABLE_NAME || '',
    checkpoint2WaitMs: Number(process.env.CHECKPOINT_2_WAIT_MS || '30000'),
  };
}

async function runCheckpoint2(
  detail: DeploymentApprovedEvent,
  config: DeploymentConfig
): Promise<{ score: number; checkpoint: CheckpointRecord; priorCheckpoints: CheckpointRecord[] }> {
  if (config.checkpoint2WaitMs > 0) {
    await delay(config.checkpoint2WaitMs);
  }

  // Fetch existing checkpoints so checkpoint2 can be appended rather than overwriting checkpoint1
  const execution = await getItem<{
    checkpoints?: CheckpointRecord[];
    repoContext?: { blastRadiusMultiplier?: number };
    signalsReceived?: Record<string, Signal>;
  }>(config.executionsTableName, { executionId: detail.executionId });
  const priorCheckpoints = execution?.checkpoints ?? [];
  const blastRadiusMultiplier = execution?.repoContext?.blastRadiusMultiplier ?? 1.0;
  const ingestedSignals: Signal[] = execution?.signalsReceived
    ? Object.values(execution.signalsReceived)
    : [];

  const signals: Signal[] = [...ingestedSignals];
  signals.push({
    signalType: 'time_of_day',
    value: Date.now(),
    source: 'system',
    timestamp: Date.now(),
  });

  let calibrationFactor = 1.0;
  if (config.calibrationTableName) {
    const calRecord = await getItem<{ calibrationFactor: number }>(config.calibrationTableName, {
      repoFullName: detail.repoFullName,
    });
    calibrationFactor = calRecord?.calibrationFactor ?? 1.0;
  }

  const evaluation = evaluateRisk({
    llmBaseScore: detail.riskScore,
    signals,
    calibrationFactor,
    blastRadiusMultiplier,
  });

  const checkpoint: CheckpointRecord = {
    type: 'pre-deploy',
    score: evaluation.score,
    confidence: evaluation.confidence,
    missingSignals: evaluation.missingSignals,
    signals,
    decision: evaluation.score >= DEPLOYMENT_THRESHOLD ? 'held' : 'approved',
    reason: evaluation.reason,
    evaluatedAt: Date.now(),
  };

  return { score: evaluation.score, checkpoint, priorCheckpoints };
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
        const backoffMs = Math.min(500 * Math.pow(2, attempt), 5000);
        const jitteredMs = Math.floor(backoffMs * (0.5 + Math.random() * 0.5));
        await delay(jitteredMs);
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
    Authorization: `Bearer ${config.deploymentWebhookAuthToken}`,
  };

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
      const sanitizedBody = responseText.substring(0, 200).replace(/bearer\s+\S+/gi, '[REDACTED]');
      throw new Error(`Deployment webhook failed with ${response.status}: ${sanitizedBody}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
