// benchmarks/src/queue.bench.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// These benchmarks require a live Redis instance.
// Skip gracefully when REDIS_URL or REDIS_HOST is not set.
import { registerSuite } from './harness';
import { faker } from '@faker-js/faker';

const REDIS_URL =
  process.env['REDIS_URL'] ??
  (process.env['REDIS_HOST'] ? `redis://${process.env['REDIS_HOST']}:6379` : null);

if (REDIS_URL) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { Queue, FlowProducer } = require('bullmq');

  const connection = {
    host: new URL(REDIS_URL).hostname,
    port: parseInt(new URL(REDIS_URL).port || '6379', 10),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const benchQueue = new Queue('bench-benchmark', { connection });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const flowProducer = new FlowProducer({ connection });

  registerSuite({
    name: 'queue',
    iterations: 50,
    tasks: [
      {
        name: 'addJob — single job enqueue',
        tags: ['io'],
        fn: async () => {
          await benchQueue.add('bench.job', {
            executionId: faker.string.uuid(),
            payload: faker.lorem.paragraph(),
          });
        },
      },
      {
        name: 'BullMQ Flow — parent + 4 agent children',
        tags: ['io'],
        fn: async () => {
          const executionId = faker.string.uuid();
          await flowProducer.add({
            name: 'synthesis',
            queueName: 'bench-synthesis',
            data: { executionId },
            children: ['architecture', 'security', 'performance', 'style'].map((agentType) => ({
              name: 'agent',
              queueName: 'bench-agent',
              data: { executionId, agentType },
            })),
          });
        },
      },
    ],
  });
}
