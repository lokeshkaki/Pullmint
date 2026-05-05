import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfigOptional } from '@pullmint/shared/config';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { createStructuredError } from '@pullmint/shared/error-handling';
import { publishExecutionUpdate } from '@pullmint/shared/execution-events';
import { evaluateRisk } from '@pullmint/shared/risk-evaluator';
import { resolveSignalWeights } from '@pullmint/shared/signal-weights';
import type {
  DeploymentApprovedEvent,
  DeploymentStatusEvent,
  Signal,
  CheckpointRecord,
} from '@pullmint/shared/types';

const DEPLOYMENT_THRESHOLD = 40;

type DeploymentOutcome = {
  status: 'deployed' | 'failed';
  message: string;
  rollbackStatus: 'triggered' | 'failed' | 'not-configured';
};

type DeploymentConfig = {
  deploymentDelayMs: number;
  deploymentWebhookUrl?: string;
  deploymentWebhookAuthToken: string;
  deploymentWebhookTimeoutMs: number;
  deploymentWebhookRetries: number;
  rollbackWebhookUrl?: string;
  checkpoint2WaitMs: number;
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

export async function processDeploymentJob(job: Job): Promise<void> {
  const detail = job.data as DeploymentApprovedEvent & { checkpoint2Complete?: boolean };
  addTraceAnnotations({ executionId: detail.executionId, prNumber: detail.prNumber });
  const config = getDeploymentConfig();
  const db = getDb();
  let deployingStatusSet = false;

  try {
    // Idempotency: skip if deployment already started
    const [existing] = await db
      .select({ deploymentStartedAt: schema.executions.deploymentStartedAt })
      .from(schema.executions)
      .where(eq(schema.executions.executionId, detail.executionId))
      .limit(1);

    if (existing?.deploymentStartedAt) {
      if (detail.checkpoint2Complete) {
        deployingStatusSet = true;
      } else {
        console.warn(
          `Deployment already started for ${detail.executionId} — skipping duplicate invocation`
        );
        return;
      }
    } else {
      await publishExecutionUpdate(detail.executionId, {
        status: 'deploying',
        deploymentStrategy: detail.deploymentStrategy,
        deploymentStartedAt: new Date().toISOString(),
        metadata: {
          deploymentStatus: 'deploying',
          deploymentEnvironment: detail.deploymentEnvironment,
        },
      });
      deployingStatusSet = true;
    }

    const waitMs = Number(getConfigOptional('CHECKPOINT_2_WAIT_MS') ?? '30000');
    if (waitMs > 0 && !detail.checkpoint2Complete) {
      await addJob(
        QUEUE_NAMES.DEPLOYMENT,
        job.name,
        { ...detail, checkpoint2Complete: true },
        { delay: waitMs, jobId: `${detail.executionId}-checkpoint2` }
      );
      deployingStatusSet = false;
      return;
    }

    // Checkpoint 2: re-evaluate risk with late signals before deploying
    const {
      score: checkpoint2Score,
      checkpoint: checkpoint2,
      priorCheckpoints,
    } = await runCheckpoint2(detail);

    if (checkpoint2Score >= DEPLOYMENT_THRESHOLD) {
      await publishExecutionUpdate(detail.executionId, {
        status: 'deployment-blocked',
        checkpoints: [...priorCheckpoints, checkpoint2] as unknown,
      });
      deployingStatusSet = false;
      return;
    }

    const outcome = await performDeployment(detail, config);

    await publishExecutionUpdate(detail.executionId, {
      status: outcome.status === 'deployed' ? 'monitoring' : 'failed',
      checkpoints: [...priorCheckpoints, checkpoint2] as unknown,
      deploymentCompletedAt: new Date().toISOString(),
      metadata: {
        deploymentStatus: outcome.status,
        deploymentEnvironment: detail.deploymentEnvironment,
        deploymentMessage: outcome.message,
        rollbackStatus: outcome.rollbackStatus,
      },
    });
    deployingStatusSet = false;

    const statusEvent: DeploymentStatusEvent = {
      ...detail,
      deploymentStatus: outcome.status,
      message: outcome.message,
    };
    await addJob(
      QUEUE_NAMES.GITHUB_INTEGRATION,
      'deployment.status',
      statusEvent as unknown as Record<string, unknown>
    );
  } catch (error) {
    const structuredError = createStructuredError(
      error instanceof Error ? error : new Error('Unknown error'),
      {
        context: 'deployment-processor',
        executionId: detail.executionId,
        repoFullName: detail.repoFullName,
      }
    );
    console.error('Deployment orchestration error:', JSON.stringify(structuredError));
    throw error;
  } finally {
    if (deployingStatusSet) {
      try {
        await publishExecutionUpdate(detail.executionId, {
          status: 'failed',
          metadata: {
            deploymentStatus: 'failed',
            deploymentMessage:
              'Unhandled error during deployment — status recovered by finally block',
          },
          deploymentCompletedAt: new Date().toISOString(),
        });
      } catch (finallyError) {
        console.error('CRITICAL: Failed to write terminal status in finally block', finallyError);
      }
    }
  }
}

async function runCheckpoint2(
  detail: DeploymentApprovedEvent
): Promise<{ score: number; checkpoint: CheckpointRecord; priorCheckpoints: CheckpointRecord[] }> {
  const db = getDb();

  const [execution] = await db
    .select({
      checkpoints: schema.executions.checkpoints,
      repoContext: schema.executions.repoContext,
      signalsReceived: schema.executions.signalsReceived,
    })
    .from(schema.executions)
    .where(eq(schema.executions.executionId, detail.executionId))
    .limit(1);

  const priorCheckpoints = Array.isArray(execution?.checkpoints)
    ? (execution.checkpoints as CheckpointRecord[])
    : [];
  const blastRadiusMultiplier = (execution?.repoContext?.blastRadiusMultiplier as number) ?? 1.0;
  const ingestedSignals: Signal[] = execution?.signalsReceived
    ? (Object.values(execution.signalsReceived) as Signal[])
    : [];

  const signals: Signal[] = [
    ...ingestedSignals,
    {
      signalType: 'time_of_day',
      value: Date.now(),
      source: 'system',
      timestamp: Date.now(),
    },
  ];

  let calibrationFactor = 1.0;
  const [calRecord] = await db
    .select({ calibrationFactor: schema.calibrations.calibrationFactor })
    .from(schema.calibrations)
    .where(eq(schema.calibrations.repoFullName, detail.repoFullName))
    .limit(1);
  if (calRecord) {
    calibrationFactor = calRecord.calibrationFactor ?? 1.0;
  }

  const signalWeights = await resolveSignalWeights(detail.repoFullName, db);

  const evaluation = evaluateRisk({
    llmBaseScore: detail.riskScore,
    signals,
    calibrationFactor,
    blastRadiusMultiplier,
    signalWeights,
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
    let rollbackStatus: DeploymentOutcome['rollbackStatus'] = 'not-configured';
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
        rollbackMessage = ` Rollback failed: ${String(rollbackError)}.`;
      }
    }

    return {
      status: 'failed',
      message: `Deployment failed: ${failureMessage}.${rollbackMessage}`,
      rollbackStatus,
    };
  }
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    deploymentDelayMs: Number(getConfigOptional('DEPLOYMENT_DELAY_MS') ?? '0'),
    deploymentWebhookUrl: getConfigOptional('DEPLOYMENT_WEBHOOK_URL'),
    deploymentWebhookAuthToken: getConfigOptional('DEPLOYMENT_WEBHOOK_SECRET') ?? '',
    deploymentWebhookTimeoutMs: Number(
      getConfigOptional('DEPLOYMENT_WEBHOOK_TIMEOUT_MS') ?? '10000'
    ),
    deploymentWebhookRetries: Number(getConfigOptional('DEPLOYMENT_WEBHOOK_RETRIES') ?? '2'),
    rollbackWebhookUrl: getConfigOptional('DEPLOYMENT_ROLLBACK_WEBHOOK_URL'),
    checkpoint2WaitMs: Number(getConfigOptional('CHECKPOINT_2_WAIT_MS') ?? '30000'),
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
        const backoffMs = Math.min(500 * Math.pow(2, attempt), 5000);
        await delay(Math.floor(backoffMs * (0.5 + Math.random() * 0.5)));
      }
    }
  }

  throw lastError ?? new Error('Deployment webhook failed');
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
      throw new Error(`Webhook responded ${response.status}: ${sanitizedBody}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
