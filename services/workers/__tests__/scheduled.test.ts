import type IORedis from 'ioredis';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@pullmint/shared/queue', () => ({
  QUEUE_NAMES: {
    DEPLOYMENT_STATUS: 'deployment-status',
    REPO_INDEXING: 'repo-indexing',
    CLEANUP: 'cleanup',
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
  Queue.mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  }));
});

describe('registerScheduledJobs', () => {
  it('creates 3 queues and calls upsertJobScheduler for each', async () => {
    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    expect(Queue).toHaveBeenCalledTimes(3);
    const [q1, q2, q3] = Queue.mock.results.map(
      (r) => r.value as { upsertJobScheduler: jest.Mock }
    );
    expect(q1.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(q2.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(q3.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('schedules deployment-monitor every 5 minutes', async () => {
    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    const q1 = Queue.mock.results[0].value as { upsertJobScheduler: jest.Mock };
    const [[schedulerName, pattern, jobOpts]] = q1.upsertJobScheduler.mock.calls as [
      string,
      unknown,
      { name: string },
    ][];
    expect(schedulerName).toBe('deployment-monitor-schedule');
    expect(pattern).toEqual({ every: 5 * 60 * 1000 });
    expect(jobOpts.name).toBe('deployment-monitor');
  });

  it('schedules dependency-scanner as daily cron at 2AM UTC', async () => {
    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    const q2 = Queue.mock.results[1].value as { upsertJobScheduler: jest.Mock };
    const [[schedulerName, pattern]] = q2.upsertJobScheduler.mock.calls as [
      string,
      { pattern: string },
    ][];
    expect(schedulerName).toBe('dependency-scanner-schedule');
    expect(pattern).toEqual({ pattern: '0 2 * * *' });
  });

  it('schedules cleanup as hourly cron', async () => {
    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    const q3 = Queue.mock.results[2].value as { upsertJobScheduler: jest.Mock };
    const [[schedulerName, pattern]] = q3.upsertJobScheduler.mock.calls as [
      string,
      { pattern: string },
    ][];
    expect(schedulerName).toBe('cleanup-schedule');
    expect(pattern).toEqual({ pattern: '0 * * * *' });
  });
});
