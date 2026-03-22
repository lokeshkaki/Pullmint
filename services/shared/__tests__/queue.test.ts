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
    const { addJob, QUEUE_NAMES } = await import('../queue');
    await addJob(QUEUE_NAMES.ANALYSIS, 'pr.opened', { executionId: '123' });
    const bullmqModule = await import('bullmq');
    const Queue = bullmqModule.Queue as jest.Mock;
    const queueInstance = Queue.mock.results[0].value;
    expect(queueInstance.add).toHaveBeenCalledWith(
      'pr.opened',
      { executionId: '123' },
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('should reject payloads exceeding 256KB', async () => {
    const { addJob, QUEUE_NAMES } = await import('../queue');
    const largePayload = { data: 'x'.repeat(300 * 1024) };
    await expect(addJob(QUEUE_NAMES.ANALYSIS, 'test', largePayload)).rejects.toThrow(
      /exceeds maximum size/
    );
  });

  it('should reuse queue instances', async () => {
    const { getQueue } = await import('../queue');
    const q1 = getQueue('test');
    const q2 = getQueue('test');
    expect(q1).toBe(q2);
  });

  it('should close all queues and redis connection', async () => {
    const { closeQueues, getQueue } = await import('../queue');
    getQueue('test-cleanup');

    await closeQueues();

    const bullmqModule = await import('bullmq');
    const Queue = bullmqModule.Queue as jest.Mock;
    const queueInstance = Queue.mock.results[0].value;
    expect(queueInstance.close).toHaveBeenCalledTimes(1);

    const ioredisModule = await import('ioredis');
    const IORedis = ioredisModule.default as jest.Mock;
    const redisInstance = IORedis.mock.results[0].value;
    expect(redisInstance.quit).toHaveBeenCalledTimes(1);
  });
});
