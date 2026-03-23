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
    CALIBRATION: 'calibration',
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
  it('creates 4 queues and calls upsertJobScheduler for each', async () => {
    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    expect(Queue).toHaveBeenCalledTimes(4);
    const [q1, q2, q3, q4] = Queue.mock.results.map(
      (r) => r.value as { upsertJobScheduler: jest.Mock }
    );
    expect(q1.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(q2.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(q3.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(q4.upsertJobScheduler).toHaveBeenCalledTimes(1);
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

  it('schedules signal recalibration as weekly cron using default', async () => {
    delete process.env.SIGNAL_RECALIBRATION_CRON;

    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    const q4 = Queue.mock.results[3].value as { upsertJobScheduler: jest.Mock };
    const [[schedulerName, pattern, jobOpts]] = q4.upsertJobScheduler.mock.calls as [
      string,
      { pattern: string },
      { name: string },
    ][];
    expect(schedulerName).toBe('signal-recalibration-schedule');
    expect(pattern).toEqual({ pattern: '0 3 * * 0' });
    expect(jobOpts.name).toBe('signal.recalibration');
  });

  it('schedules signal recalibration using env override cron', async () => {
    process.env.SIGNAL_RECALIBRATION_CRON = '15 4 * * 1';

    const { registerScheduledJobs } = await import('../src/scheduled');
    const { Queue } = jest.requireMock('bullmq') as { Queue: jest.Mock };
    const connection = {} as IORedis;

    await registerScheduledJobs(connection);

    const q4 = Queue.mock.results[3].value as { upsertJobScheduler: jest.Mock };
    const [[schedulerName, pattern]] = q4.upsertJobScheduler.mock.calls as [
      string,
      { pattern: string },
    ][];
    expect(schedulerName).toBe('signal-recalibration-schedule');
    expect(pattern).toEqual({ pattern: '15 4 * * 1' });

    delete process.env.SIGNAL_RECALIBRATION_CRON;
  });
});
