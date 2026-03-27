import { Queue, type QueueOptions } from 'bullmq';
import IORedis from 'ioredis';

const MAX_PAYLOAD_BYTES = 256 * 1024;

let redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  return redisConnection;
}

const queues = new Map<string, Queue>();

export function getQueue(name: string, opts?: Partial<QueueOptions>): Queue {
  if (!queues.has(name)) {
    const queue = new Queue(name, {
      // BullMQ may resolve its own ioredis package instance, so we cast here to bridge duplicate types.
      connection: getRedisConnection() as unknown as QueueOptions['connection'],
      ...opts,
    });
    queues.set(name, queue);
  }

  return queues.get(name)!;
}

export const QUEUE_NAMES = {
  ANALYSIS: 'analysis',
  AGENT: 'agent',
  SYNTHESIS: 'synthesis',
  GITHUB_INTEGRATION: 'github-integration',
  DEPLOYMENT: 'deployment',
  DEPLOYMENT_STATUS: 'deployment-status',
  CALIBRATION: 'calibration',
  REPO_INDEXING: 'repo-indexing',
  CLEANUP: 'cleanup',
  NOTIFICATION: 'notification',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export async function addJob(
  queueName: QueueName,
  jobType: string,
  data: Record<string, unknown>,
  opts?: {
    jobId?: string;
    delay?: number;
    attempts?: number;
    backoff?: { type: 'exponential' | 'fixed'; delay: number };
  }
): Promise<void> {
  const payload = JSON.stringify(data);
  const payloadBytes = Buffer.byteLength(payload, 'utf-8');

  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Job payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes (actual: ${payloadBytes} bytes). ` +
        'Store large data in object storage and pass a reference instead.'
    );
  }

  const queue = getQueue(queueName);
  await queue.add(jobType, data, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: opts?.attempts ?? 3,
    backoff: opts?.backoff ?? { type: 'exponential', delay: 1000 },
    ...(opts?.jobId && { jobId: opts.jobId }),
    ...(opts?.delay && { delay: opts.delay }),
  });
}

export async function closeQueues(): Promise<void> {
  for (const queue of queues.values()) {
    await queue.close();
  }

  queues.clear();

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
