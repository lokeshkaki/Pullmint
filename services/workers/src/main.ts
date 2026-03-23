import { Worker, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { initTracing } from '@pullmint/shared/tracing';
import { QUEUE_NAMES } from '@pullmint/shared/queue';
import { closePublisher } from '@pullmint/shared/execution-events';
import { processAnalysisJob } from './processors/analysis.js';
import { processAgentJob } from './processors/agent.js';
import { processSynthesisJob } from './processors/synthesis.js';
import { processGitHubIntegrationJob } from './processors/github-integration.js';
import { processDeploymentJob } from './processors/deployment.js';
import { processDeploymentStatusJob } from './processors/deployment-status.js';
import { processCalibrationJob } from './processors/calibration.js';
import { processRepoIndexingJob } from './processors/repo-indexing.js';
import { processCleanupJob } from './processors/cleanup.js';
import { registerScheduledJobs } from './scheduled.js';

async function start(): Promise<void> {
  initTracing('pullmint-workers');

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = connection as unknown as WorkerOptions['connection'];

  console.log('Starting Pullmint workers...');

  const workers: Worker[] = [];

  // Analysis queue (now acts as dispatcher — creates BullMQ Flows)
  workers.push(
    new Worker(QUEUE_NAMES.ANALYSIS, processAnalysisJob, {
      connection: workerConnection,
      concurrency: 2,
    })
  );

  // GitHub integration queue
  workers.push(
    new Worker(QUEUE_NAMES.GITHUB_INTEGRATION, processGitHubIntegrationJob, {
      connection: workerConnection,
      concurrency: 5,
    })
  );

  // Deployment queue (deployment-orchestrator + rollback)
  workers.push(
    new Worker(QUEUE_NAMES.DEPLOYMENT, processDeploymentJob, {
      connection: workerConnection,
      concurrency: 3,
    })
  );

  // Deployment status queue
  workers.push(
    new Worker(QUEUE_NAMES.DEPLOYMENT_STATUS, processDeploymentStatusJob, {
      connection: workerConnection,
      concurrency: 5,
    })
  );

  // Calibration queue
  workers.push(
    new Worker(QUEUE_NAMES.CALIBRATION, processCalibrationJob, {
      connection: workerConnection,
      concurrency: 3,
    })
  );

  // Repo indexing queue
  workers.push(
    new Worker(QUEUE_NAMES.REPO_INDEXING, processRepoIndexingJob, {
      connection: workerConnection,
      concurrency: 2,
    })
  );

  // Cleanup queue (TTL cleanup for PostgreSQL)
  workers.push(
    new Worker(QUEUE_NAMES.CLEANUP, processCleanupJob, {
      connection: workerConnection,
      concurrency: 1,
    })
  );

  // Agent queue — individual LLM analysis jobs (high concurrency for parallel agents)
  workers.push(
    new Worker(QUEUE_NAMES.AGENT, processAgentJob, {
      connection: workerConnection,
      concurrency: 4,
    })
  );

  // Synthesis queue — merges agent results after all children complete
  workers.push(
    new Worker(QUEUE_NAMES.SYNTHESIS, processSynthesisJob, {
      connection: workerConnection,
      concurrency: 3,
    })
  );

  // Register scheduled/repeatable jobs
  await registerScheduledJobs(connection);

  // Log worker events
  for (const worker of workers) {
    worker.on('completed', (job) => {
      console.log(`[${worker.name}] Job ${job.id ?? 'unknown'} (${job.name}) completed`);
    });
    worker.on('failed', (job, err) => {
      console.error(
        `[${worker.name}] Job ${job?.id ?? 'unknown'} (${job?.name ?? 'unknown'}) failed:`,
        err.message
      );
    });
  }

  console.log(`Workers started: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down workers...');
    await Promise.all(workers.map((w) => w.close()));
    await closePublisher();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

start().catch((err) => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});
