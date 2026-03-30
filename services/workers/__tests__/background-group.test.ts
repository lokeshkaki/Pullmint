import { startBackgroundGroup } from '../src/groups/background-group';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((queueName: string) => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    name: queueName,
  })),
}));

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
  }))
);

jest.mock('@pullmint/shared/tracing', () => ({
  initTracing: jest.fn(),
}));

jest.mock('@pullmint/shared/queue', () => ({
  QUEUE_NAMES: {
    CALIBRATION: 'calibration',
    REPO_INDEXING: 'repo-indexing',
    CLEANUP: 'cleanup',
  },
  closeQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pullmint/shared/execution-events', () => ({
  closePublisher: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/processors/calibration', () => ({
  processCalibrationJob: jest.fn(),
}));

jest.mock('../src/processors/repo-indexing', () => ({
  processRepoIndexingJob: jest.fn(),
}));

jest.mock('../src/processors/cleanup', () => ({
  processCleanupJob: jest.fn(),
}));

jest.mock('../src/scheduled', () => ({
  registerScheduledJobs: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REDIS_URL;
});

describe('startBackgroundGroup', () => {
  it('creates workers for calibration, repo-indexing, and cleanup queues', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };

    await startBackgroundGroup();

    expect(MockWorker).toHaveBeenCalledTimes(3);
    const queueNames = (MockWorker.mock.calls as [string][]).map((c) => c[0]);
    expect(queueNames).toContain('calibration');
    expect(queueNames).toContain('repo-indexing');
    expect(queueNames).toContain('cleanup');
  });

  it('connects to Redis and calls ping', async () => {
    const IORedisConstructor = jest.requireMock('ioredis') as jest.Mock;

    await startBackgroundGroup();

    expect(IORedisConstructor).toHaveBeenCalledTimes(1);
    const instance = IORedisConstructor.mock.results[0].value as { ping: jest.Mock };
    expect(instance.ping).toHaveBeenCalledTimes(1);
  });

  it('registers scheduled jobs with the Redis connection', async () => {
    const IORedisConstructor = jest.requireMock('ioredis') as jest.Mock;
    const { registerScheduledJobs } = jest.requireMock('../src/scheduled') as {
      registerScheduledJobs: jest.Mock;
    };

    await startBackgroundGroup();

    const connection = IORedisConstructor.mock.results[0].value;
    expect(registerScheduledJobs).toHaveBeenCalledWith(connection);
  });

  it('registers completed and failed event handlers on each worker', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };

    await startBackgroundGroup();

    const workerInstances = MockWorker.mock.results.map(
      (r: jest.MockResult<{ on: jest.Mock }>) => r.value
    );
    expect(workerInstances).toHaveLength(3);
    for (const instance of workerInstances) {
      expect(instance.on).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(instance.on).toHaveBeenCalledWith('failed', expect.any(Function));
    }
  });

  it('completed event handler logs job info when triggered', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await startBackgroundGroup();

    const firstWorker = MockWorker.mock.results[0].value as { on: jest.Mock };
    const completedHandler = (
      firstWorker.on.mock.calls as [string, (job: { id: string; name: string }) => void][]
    ).find((c) => c[0] === 'completed')?.[1];
    completedHandler?.({ id: '789', name: 'background-job' });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('failed event handler logs error when triggered', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await startBackgroundGroup();

    const firstWorker = MockWorker.mock.results[0].value as { on: jest.Mock };
    const failedHandler = (
      firstWorker.on.mock.calls as [
        string,
        (job: { id: string; name: string }, err: Error) => void,
      ][]
    ).find((c) => c[0] === 'failed')?.[1];
    failedHandler?.({ id: '789', name: 'background-job' }, new Error('background failure'));

    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('failed event handler logs unknown ids when job is null', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await startBackgroundGroup();

    const firstWorker = MockWorker.mock.results[0].value as { on: jest.Mock };
    const failedHandler = (
      firstWorker.on.mock.calls as [string, (job: null, err: Error) => void][]
    ).find((c) => c[0] === 'failed')?.[1];
    failedHandler?.(null, new Error('job was null'));

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown'),
      expect.any(String)
    );
    consoleErrSpy.mockRestore();
  });

  it('shutdown closes all workers, queues, publisher, and redis connection', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const IORedisConstructor = jest.requireMock('ioredis') as jest.Mock;
    const { closeQueues } = jest.requireMock('@pullmint/shared/queue') as {
      closeQueues: jest.Mock;
    };
    const { closePublisher } = jest.requireMock('@pullmint/shared/execution-events') as {
      closePublisher: jest.Mock;
    };

    const { shutdown } = await startBackgroundGroup();

    const workerInstances = MockWorker.mock.results.map(
      (r: jest.MockResult<{ close: jest.Mock }>) => r.value
    );
    const connection = IORedisConstructor.mock.results[0].value as { quit: jest.Mock };

    await shutdown();

    for (const instance of workerInstances) {
      expect(instance.close).toHaveBeenCalled();
    }
    expect(closeQueues).toHaveBeenCalled();
    expect(closePublisher).toHaveBeenCalled();
    expect(connection.quit).toHaveBeenCalled();
  });
});
