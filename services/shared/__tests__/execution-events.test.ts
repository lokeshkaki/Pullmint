const mockPublish = jest.fn().mockResolvedValue(1);
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    publish: mockPublish,
    quit: jest.fn().mockResolvedValue('OK'),
  }));
});

// Mock db - we test publishEvent which doesn't need complex db mocking
jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: {
    executions: {
      executionId: 'execution_id',
      repoFullName: 'repo_full_name',
      prNumber: 'pr_number',
      status: 'status',
      riskScore: 'risk_score',
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ field: a, value: b })),
  sql: jest.fn((strings) => ({ raw: strings })),
}));

describe('execution-events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublish.mockResolvedValue(1);
  });

  describe('publishEvent', () => {
    it('publishes pre-built event to Redis', async () => {
      const { publishEvent } = await import('../execution-events');

      const event = {
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        prNumber: 1,
        status: 'analyzing',
        riskScore: 25,
        updatedAt: Date.now(),
      };

      await publishEvent(event);

      expect(mockPublish).toHaveBeenCalledWith('pullmint:execution-updates', JSON.stringify(event));
    });

    it('publishes to correct channel name', async () => {
      const { publishEvent } = await import('../execution-events');

      const event = {
        executionId: 'exec-2',
        repoFullName: 'myorg/myrepo',
        prNumber: 42,
        status: 'completed',
        riskScore: 73,
        updatedAt: 1234567890,
      };

      await publishEvent(event);

      expect(mockPublish).toHaveBeenCalledWith(
        'pullmint:execution-updates',
        expect.stringContaining('exec-2')
      );
      expect(mockPublish).toHaveBeenCalledWith(
        'pullmint:execution-updates',
        expect.stringContaining('myorg/myrepo')
      );
    });

    it('does not throw when Redis publish fails', async () => {
      mockPublish.mockRejectedValue(new Error('Redis connection error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const { publishEvent } = await import('../execution-events');

      const event = {
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        prNumber: 1,
        status: 'analyzing',
        riskScore: 25,
        updatedAt: Date.now(),
      };

      // Should not throw
      await expect(publishEvent(event)).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to publish execution event:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('closePublisher', () => {
    it('closes the Redis publisher connection', async () => {
      const { publishEvent, closePublisher } = await import('../execution-events');

      const event = {
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        prNumber: 1,
        status: 'analyzing',
        riskScore: 25,
        updatedAt: Date.now(),
      };

      // Trigger publisher creation
      await publishEvent(event);

      // Mock quit was called when closePublisher is called
      // We just verify it doesn't throw
      await expect(closePublisher()).resolves.toBeUndefined();
    });

    it('idempotent - can call closePublisher multiple times', async () => {
      const { publishEvent, closePublisher } = await import('../execution-events');

      const event = {
        executionId: 'exec-1',
        repoFullName: 'org/repo',
        prNumber: 1,
        status: 'analyzing',
        riskScore: 25,
        updatedAt: Date.now(),
      };

      // Trigger publisher creation
      await publishEvent(event);

      // Close twice should not throw
      await expect(closePublisher()).resolves.toBeUndefined();
      await expect(closePublisher()).resolves.toBeUndefined();
    });
  });
});
