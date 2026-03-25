import { Worker, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { initTracing } from '@pullmint/shared/tracing';
import { QUEUE_NAMES, closeQueues } from '@pullmint/shared/queue';
import { closePublisher } from '@pullmint/shared/execution-events';
import { processGitHubIntegrationJob } from '../processors/github-integration.js';
import { processDeploymentJob } from '../processors/deployment.js';
import { processDeploymentStatusJob } from '../processors/deployment-status.js';

export async function startIntegrationGroup(): Promise<{ shutdown: () => Promise<void> }> {
  initTracing('pullmint-workers-integration');

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  await connection.ping();
  const workerConnection = connection as unknown as WorkerOptions['connection'];

  const workers: Worker[] = [];

  workers.push(
    new Worker(QUEUE_NAMES.GITHUB_INTEGRATION, processGitHubIntegrationJob, {
      connection: workerConnection,
      concurrency: 5,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.DEPLOYMENT, processDeploymentJob, {
      connection: workerConnection,
      concurrency: 3,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.DEPLOYMENT_STATUS, processDeploymentStatusJob, {
      connection: workerConnection,
      concurrency: 5,
    })
  );

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

  console.log(`Integration group started: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down integration group...');
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closePublisher();
    await connection.quit();
  };

  return { shutdown };
}
