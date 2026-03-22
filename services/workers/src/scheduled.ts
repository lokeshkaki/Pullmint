import IORedis from 'ioredis';
import { Queue, QueueOptions } from 'bullmq';
import { QUEUE_NAMES } from '@pullmint/shared/queue';

export async function registerScheduledJobs(connection: IORedis): Promise<void> {
  // Deployment monitor — every 5 minutes
  // Replaces: DeploymentMonitorSchedule CloudWatch Events rule
  const deploymentStatusQueue = new Queue(QUEUE_NAMES.DEPLOYMENT_STATUS, {
    connection: connection as QueueOptions['connection'],
  });
  await deploymentStatusQueue.upsertJobScheduler(
    'deployment-monitor-schedule',
    { every: 5 * 60 * 1000 },
    { name: 'deployment-monitor', data: { scheduled: true } }
  );

  // Dependency scanner — daily at 2 AM UTC
  // Replaces: DependencyScannerSchedule CloudWatch Events rule
  const repoIndexingQueue = new Queue(QUEUE_NAMES.REPO_INDEXING, {
    connection: connection as QueueOptions['connection'],
  });
  await repoIndexingQueue.upsertJobScheduler(
    'dependency-scanner-schedule',
    { pattern: '0 2 * * *' },
    { name: 'dependency-scanner', data: { scheduled: true } }
  );

  // Cleanup — hourly, deletes expired rows
  // Replaces managed TTL auto-expiry
  const cleanupQueue = new Queue(QUEUE_NAMES.CLEANUP, {
    connection: connection as QueueOptions['connection'],
  });
  await cleanupQueue.upsertJobScheduler(
    'cleanup-schedule',
    { pattern: '0 * * * *' },
    { name: 'cleanup', data: { scheduled: true } }
  );

  console.log(
    'Scheduled jobs registered: deployment-monitor (5min), dependency-scanner (daily 2AM), cleanup (hourly)'
  );
}
