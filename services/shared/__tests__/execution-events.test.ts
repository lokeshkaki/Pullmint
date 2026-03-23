const mockPublish = jest.fn().mockResolvedValue(1);
const mockQuit = jest.fn().mockResolvedValue('OK');

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    publish: mockPublish,
    quit: mockQuit,
  }));
});

const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockUpdateSet = jest.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = jest.fn().mockReturnValue({ set: mockUpdateSet });

const mockLimit = jest.fn();
const mockSelectWhere = jest.fn().mockReturnValue({ limit: mockLimit });
const mockSelectFrom = jest.fn().mockReturnValue({ where: mockSelectWhere });
const mockSelect = jest.fn().mockReturnValue({ from: mockSelectFrom });

const mockDb = {
  update: mockUpdate,
  select: mockSelect,
};

jest.mock('../db', () => ({
  getDb: jest.fn(() => mockDb),
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
}));

import {
  closePublisher,
  publishEvent,
  publishExecutionUpdate,
  type ExecutionUpdateEvent,
} from '../execution-events';

describe('execution-events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublish.mockResolvedValue(1);
    mockLimit.mockResolvedValue([]);
  });

  afterEach(async () => {
    await closePublisher();
  });

  describe('publishExecutionUpdate', () => {
    it('performs DB update and publishes event payload', async () => {
      mockLimit.mockResolvedValue([
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 1,
          status: 'analyzing',
          riskScore: 25,
        },
      ]);

      await publishExecutionUpdate('exec-1', { status: 'analyzing' });

      expect(mockUpdate).toHaveBeenCalledWith({
        executionId: 'execution_id',
        repoFullName: 'repo_full_name',
        prNumber: 'pr_number',
        status: 'status',
        riskScore: 'risk_score',
      });
      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'analyzing',
        updatedAt: expect.any(Date),
      });
      expect(mockUpdateWhere).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'pullmint:execution-updates',
        expect.stringContaining('"executionId":"exec-1"')
      );
      expect(mockPublish).toHaveBeenCalledWith(
        'pullmint:execution-updates',
        expect.stringContaining('"repoFullName":"org/repo"')
      );
    });

    it('does not publish when execution is not found after update', async () => {
      mockLimit.mockResolvedValue([]);

      await publishExecutionUpdate('missing-exec', { status: 'analyzing' });

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('does not throw when Redis publish fails', async () => {
      mockLimit.mockResolvedValue([
        {
          executionId: 'exec-1',
          repoFullName: 'org/repo',
          prNumber: 1,
          status: 'analyzing',
          riskScore: 25,
        },
      ]);
      mockPublish.mockRejectedValueOnce(new Error('Redis connection error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(
        publishExecutionUpdate('exec-1', { status: 'analyzing' })
      ).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to publish execution update event:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('publishEvent', () => {
    it('publishes pre-built event to Redis', async () => {
      const event: ExecutionUpdateEvent = {
        executionId: 'exec-2',
        repoFullName: 'myorg/myrepo',
        prNumber: 42,
        status: 'completed',
        riskScore: 73,
        updatedAt: 1234567890,
      };

      await publishEvent(event);

      expect(mockPublish).toHaveBeenCalledWith('pullmint:execution-updates', JSON.stringify(event));
    });

    it('does not throw when Redis publish fails', async () => {
      mockPublish.mockRejectedValueOnce(new Error('Redis connection error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const event: ExecutionUpdateEvent = {
        executionId: 'exec-3',
        repoFullName: 'org/repo',
        prNumber: 1,
        status: 'analyzing',
        riskScore: 25,
        updatedAt: Date.now(),
      };

      await expect(publishEvent(event)).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to publish execution event:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('closePublisher', () => {
    it('closes the Redis publisher connection and is idempotent', async () => {
      const event: ExecutionUpdateEvent = {
        executionId: 'exec-4',
        repoFullName: 'org/repo',
        prNumber: 10,
        status: 'analyzing',
        riskScore: 50,
        updatedAt: Date.now(),
      };

      await publishEvent(event);
      await closePublisher();
      await closePublisher();

      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });
});
