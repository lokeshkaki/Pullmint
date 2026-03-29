import { Worker, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { initTracing } from '@pullmint/shared/tracing';
import { QUEUE_NAMES, closeQueues } from '@pullmint/shared/queue';
import { closePublisher } from '@pullmint/shared/execution-events';
import { processAnalysisJob, closeAnalysisFlowProducer } from '../processors/analysis';
import { processAgentJob } from '../processors/agent';
import { processSynthesisJob } from '../processors/synthesis';

export async function startAnalysisGroup(): Promise<{ shutdown: () => Promise<void> }> {
  initTracing('pullmint-workers-analysis');

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  await connection.ping();
  const workerConnection = connection as unknown as WorkerOptions['connection'];

  const workers: Worker[] = [];

  workers.push(
    new Worker(QUEUE_NAMES.ANALYSIS, processAnalysisJob, {
      connection: workerConnection,
      concurrency: 2,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.AGENT, processAgentJob, {
      connection: workerConnection,
      concurrency: 8,
    })
  );

  workers.push(
    new Worker(QUEUE_NAMES.SYNTHESIS, processSynthesisJob, {
      connection: workerConnection,
      concurrency: 3,
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

  console.log(`Analysis group started: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down analysis group...');
    await Promise.all(workers.map((w) => w.close()));
    await closeAnalysisFlowProducer();
    await closeQueues();
    await closePublisher();
    await connection.quit();
  };

  return { shutdown };
}
