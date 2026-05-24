jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

describe('queue', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.REDIS_URL;
  });

  it('should add a job to a queue', async () => {
    const { addJob, QUEUE_NAMES } = require('../queue') as typeof import('../queue');
    await addJob(QUEUE_NAMES.ANALYSIS, 'pr.opened', { executionId: '123' });
    const { Queue } = require('bullmq') as { Queue: jest.Mock };
    const queueInstance = Queue.mock.results[0].value;
    expect(queueInstance.add).toHaveBeenCalledWith(
      'pr.opened',
      { executionId: '123' },
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('should reject payloads exceeding 256KB', async () => {
    const { addJob, QUEUE_NAMES } = require('../queue') as typeof import('../queue');
    const largePayload = { data: 'x'.repeat(300 * 1024) };
    await expect(addJob(QUEUE_NAMES.ANALYSIS, 'test', largePayload)).rejects.toThrow(
      /exceeds maximum size/
    );
  });

  it('should reuse queue instances', () => {
    const { getQueue } = require('../queue') as typeof import('../queue');
    const q1 = getQueue('test');
    const q2 = getQueue('test');
    expect(q1).toBe(q2);
  });

  it('should close all queues and redis connection', async () => {
    const { closeQueues, getQueue } = require('../queue') as typeof import('../queue');
    getQueue('test-cleanup');

    await closeQueues();

    const { Queue } = require('bullmq') as { Queue: jest.Mock };
    const queueInstance = Queue.mock.results[0].value;
    expect(queueInstance.close).toHaveBeenCalledTimes(1);

    const IORedis = require('ioredis') as jest.Mock;
    const redisInstance = IORedis.mock.results[0].value;
    expect(redisInstance.quit).toHaveBeenCalledTimes(1);
  });
});
