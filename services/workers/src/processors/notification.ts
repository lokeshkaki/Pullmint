import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { createStructuredError } from '@pullmint/shared/error-handling';
import { sendNotification, type NotificationPayload } from '@pullmint/shared/notifications';
import picomatch from 'picomatch';

export interface NotificationJobData {
  event: string;
  executionId: string;
  repoFullName: string;
  prNumber: number;
  prTitle?: string;
  author?: string;
  riskScore?: number;
  findingsCount?: number;
  status: string;
  summary?: string;
}

export async function processNotificationJob(job: Job): Promise<void> {
  const data = job.data as NotificationJobData;

  try {
    const db = getDb();

    const channels = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.enabled, true));

    const dashboardBaseUrl = process.env.DASHBOARD_URL ?? '';
    const payload: NotificationPayload = {
      event: data.event,
      executionId: data.executionId,
      repoFullName: data.repoFullName,
      prNumber: data.prNumber,
      prTitle: data.prTitle,
      author: data.author,
      riskScore: data.riskScore,
      findingsCount: data.findingsCount,
      status: data.status,
      summary: data.summary,
      dashboardUrl: dashboardBaseUrl
        ? `${dashboardBaseUrl}/executions/${data.executionId}`
        : undefined,
      prUrl: buildPrUrl(data.repoFullName, data.prNumber),
      timestamp: Date.now(),
    };

    const matchingChannels = channels.filter((ch) => {
      const events = ch.events;
      if (!events.includes(data.event)) return false;

      if (ch.repoFilter) {
        const isMatch = picomatch(ch.repoFilter);
        if (!isMatch(data.repoFullName)) return false;
      }

      if (ch.minRiskScore !== null && ch.minRiskScore !== undefined) {
        const score = data.riskScore ?? 0;
        if (score < ch.minRiskScore) return false;
      }

      return true;
    });

    if (matchingChannels.length === 0) {
      console.log(
        `[notification] No matching channels for event=${data.event} repo=${data.repoFullName}`
      );
      return;
    }

    console.log(
      `[notification] Dispatching to ${matchingChannels.length} channel(s) for event=${data.event}`
    );

    const results = await Promise.allSettled(
      matchingChannels.map((ch) => sendNotification(ch, payload))
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(
        `[notification] ${failed.length}/${matchingChannels.length} channel sends failed`
      );
    }
  } catch (err) {
    const structuredError = createStructuredError(
      err instanceof Error ? err : new Error(String(err)),
      {
        context: 'notification-processor',
        event: data.event,
        executionId: data.executionId,
      }
    );
    console.error('Error in notification processor:', JSON.stringify(structuredError));
    throw err;
  }
}

function buildPrUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}
