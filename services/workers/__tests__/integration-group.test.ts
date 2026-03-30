import { startIntegrationGroup } from '../src/groups/integration-group';

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
    GITHUB_INTEGRATION: 'github-integration',
    DEPLOYMENT: 'deployment',
    DEPLOYMENT_STATUS: 'deployment-status',
    NOTIFICATION: 'notification',
  },
  closeQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pullmint/shared/execution-events', () => ({
  closePublisher: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/processors/github-integration', () => ({
  processGitHubIntegrationJob: jest.fn(),
}));

jest.mock('../src/processors/deployment', () => ({
  processDeploymentJob: jest.fn(),
}));

jest.mock('../src/processors/deployment-status', () => ({
  processDeploymentStatusJob: jest.fn(),
}));

jest.mock('../src/processors/notification', () => ({
  processNotificationJob: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REDIS_URL;
});

describe('startIntegrationGroup', () => {
  it('creates workers for github-integration, deployment, deployment-status, and notification queues', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };

    await startIntegrationGroup();

    expect(MockWorker).toHaveBeenCalledTimes(4);
    const queueNames = (MockWorker.mock.calls as [string][]).map((c) => c[0]);
    expect(queueNames).toContain('github-integration');
    expect(queueNames).toContain('deployment');
    expect(queueNames).toContain('deployment-status');
    expect(queueNames).toContain('notification');
  });

  it('connects to Redis and calls ping', async () => {
    const IORedisConstructor = jest.requireMock('ioredis') as jest.Mock;

    await startIntegrationGroup();

    expect(IORedisConstructor).toHaveBeenCalledTimes(1);
    const instance = IORedisConstructor.mock.results[0].value as { ping: jest.Mock };
    expect(instance.ping).toHaveBeenCalledTimes(1);
  });

  it('registers completed and failed event handlers on each worker', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };

    await startIntegrationGroup();

    const workerInstances = MockWorker.mock.results.map(
      (r: jest.MockResult<{ on: jest.Mock }>) => r.value
    );
    expect(workerInstances).toHaveLength(4);
    for (const instance of workerInstances) {
      expect(instance.on).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(instance.on).toHaveBeenCalledWith('failed', expect.any(Function));
    }
  });

  it('completed event handler logs job info when triggered', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await startIntegrationGroup();

    const firstWorker = MockWorker.mock.results[0].value as { on: jest.Mock };
    const completedHandler = (
      firstWorker.on.mock.calls as [string, (job: { id: string; name: string }) => void][]
    ).find((c) => c[0] === 'completed')?.[1];
    completedHandler?.({ id: '456', name: 'integration-job' });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('failed event handler logs error when triggered', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await startIntegrationGroup();

    const firstWorker = MockWorker.mock.results[0].value as { on: jest.Mock };
    const failedHandler = (
      firstWorker.on.mock.calls as [
        string,
        (job: { id: string; name: string }, err: Error) => void,
      ][]
    ).find((c) => c[0] === 'failed')?.[1];
    failedHandler?.({ id: '456', name: 'integration-job' }, new Error('integration failure'));

    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('uses expected concurrency settings for each worker', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };

    await startIntegrationGroup();

    const concurrencies = (
      MockWorker.mock.calls as [string, unknown, { concurrency: number }][]
    ).map((c) => c[2].concurrency);
    expect(concurrencies).toEqual([5, 3, 5, 10]);
  });

  it('failed event handler logs unknown ids when job is null', async () => {
    const { Worker: MockWorker } = jest.requireMock('bullmq') as { Worker: jest.Mock };
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await startIntegrationGroup();

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

    const { shutdown } = await startIntegrationGroup();

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
