import { Worker, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { initTracing } from '@pullmint/shared/tracing';
import { QUEUE_NAMES, closeQueues } from '@pullmint/shared/queue';
import { closePublisher } from '@pullmint/shared/execution-events';
import { processCalibrationJob } from '../processors/calibration.js';
import { processRepoIndexingJob } from '../processors/repo-indexing.js';
import { processCleanupJob } from '../processors/cleanup.js';
import { registerScheduledJobs } from '../scheduled.js';

export async function startBackgroundGroup(): Promise<{ shutdown: () => Promise<void> }> {
  initTracing('pullmint-workers-background');

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  await connection.ping();
  const workerConnection = connection as unknown as WorkerOptions['connection'];

  const workers: Worker[] = [];

  workers.push(
    new Worker(QUEUE_NAMES.CALIBRATION, processCalibrationJob, {
      connection: workerConnection,
      concurrency: 3,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.REPO_INDEXING, processRepoIndexingJob, {
      connection: workerConnection,
      concurrency: 2,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.CLEANUP, processCleanupJob, {
      connection: workerConnection,
      concurrency: 1,
    })
  );

  await registerScheduledJobs(connection);

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

  console.log(`Background group started: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down background group...');
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closePublisher();
    await connection.quit();
  };

  return { shutdown };
}
