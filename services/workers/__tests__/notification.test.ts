import type { Job } from 'bullmq';
import { processNotificationJob } from '../src/processors/notification';

jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn(),
  schema: { notificationChannels: { enabled: 'enabled' } },
}));

jest.mock('@pullmint/shared/notifications', () => ({
  sendNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((e: Error) => ({ message: e.message })),
}));

import { getDb } from '@pullmint/shared/db';
import { sendNotification } from '@pullmint/shared/notifications';

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
};

const makeJob = (data: Record<string, unknown>): Job =>
  ({ id: 'job-1', name: 'analysis.completed', data }) as unknown as Job;

const baseJobData = {
  event: 'analysis.completed',
  executionId: 'exec-1',
  repoFullName: 'org/repo',
  prNumber: 10,
  riskScore: 50,
  status: 'completed',
};

const slackChannel = {
  id: 1,
  name: 'Slack',
  channelType: 'slack',
  webhookUrl: 'https://hooks.slack.com/test',
  repoFilter: null,
  events: ['analysis.completed'],
  minRiskScore: null,
  enabled: true,
  secret: null,
};

const discordChannel = {
  id: 2,
  name: 'Discord',
  channelType: 'discord',
  webhookUrl: 'https://discord.com/api/webhooks/test',
  repoFilter: 'org/*',
  events: ['analysis.completed', 'analysis.failed'],
  minRiskScore: 30,
  enabled: true,
  secret: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  (getDb as jest.Mock).mockReturnValue(mockDb);
});

describe('processNotificationJob', () => {
  it('sends to all matching channels', async () => {
    mockDb.where.mockResolvedValue([slackChannel, discordChannel]);

    await processNotificationJob(makeJob(baseJobData));

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('skips channels that do not subscribe to the event', async () => {
    const deployChannel = { ...slackChannel, events: ['deployment.rolled-back'] };
    mockDb.where.mockResolvedValue([deployChannel]);

    await processNotificationJob(makeJob(baseJobData));

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('skips channels whose repo filter does not match', async () => {
    const filteredChannel = { ...slackChannel, repoFilter: 'other-org/*' };
    mockDb.where.mockResolvedValue([filteredChannel]);

    await processNotificationJob(makeJob(baseJobData));

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('skips channels below min risk threshold', async () => {
    const highRiskChannel = { ...slackChannel, minRiskScore: 80 };
    mockDb.where.mockResolvedValue([highRiskChannel]);

    await processNotificationJob(makeJob({ ...baseJobData, riskScore: 30 }));

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends to channels meeting risk threshold', async () => {
    const highRiskChannel = { ...slackChannel, minRiskScore: 40 };
    mockDb.where.mockResolvedValue([highRiskChannel]);

    await processNotificationJob(makeJob({ ...baseJobData, riskScore: 55 }));

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('continues processing remaining channels when one fails', async () => {
    (sendNotification as jest.Mock)
      .mockRejectedValueOnce(new Error('channel 1 failed'))
      .mockResolvedValueOnce(undefined);

    mockDb.where.mockResolvedValue([slackChannel, discordChannel]);

    await processNotificationJob(makeJob(baseJobData));

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no channels are configured', async () => {
    mockDb.where.mockResolvedValue([]);

    await expect(processNotificationJob(makeJob(baseJobData))).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('throws and re-enqueues when DB query fails', async () => {
    mockDb.where.mockRejectedValue(new Error('DB connection lost'));

    await expect(processNotificationJob(makeJob(baseJobData))).rejects.toThrow(
      'DB connection lost'
    );
  });
});
