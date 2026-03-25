import { Job } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfigOptional } from '@pullmint/shared/config';
import { getObject } from '@pullmint/shared/storage';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { createStructuredError, retryWithBackoff } from '@pullmint/shared/error-handling';
import { publishExecutionUpdate, publishEvent } from '@pullmint/shared/execution-events';
import { FindingSchema } from '@pullmint/shared/schemas';
import { z } from 'zod';
import type { ExecutionUpdateEvent } from '@pullmint/shared/execution-events';
import type {
  PREvent,
  Finding,
  AnalysisResult,
  DeploymentApprovedEvent,
  DeploymentStatusEvent,
} from '@pullmint/shared/types';
import type { ValidatedCheckpointRecord } from '@pullmint/shared/schemas';

type CommentOpts = {
  checkpoint?: ValidatedCheckpointRecord;
  dashboardUrl?: string;
};

type DeploymentConfig = {
  deploymentRiskThreshold: number;
  autoApproveRiskThreshold: number;
  deploymentStrategy: 'eventbridge' | 'label' | 'deployment';
  deploymentLabel: string;
  deploymentEnvironment: string;
  deploymentRequireTests: boolean;
  deploymentRequiredContexts: string[];
};

interface AnalysisCompleteData extends PREvent, AnalysisResult {
  s3Key?: string;
  findingsCount?: number;
}

const octokitClients = new Map<string, Awaited<ReturnType<typeof getGitHubInstallationClient>>>();

export async function processGitHubIntegrationJob(job: Job): Promise<void> {
  const jobName = job.name;
  const detail = job.data as (AnalysisCompleteData | DeploymentStatusEvent) & {
    executionId?: string;
    prNumber?: number;
  };

  if (detail.executionId) {
    addTraceAnnotations({ executionId: detail.executionId, prNumber: detail.prNumber });
  }

  try {
    if (jobName === 'analysis.complete') {
      await handleAnalysisComplete(detail as AnalysisCompleteData);
      return;
    }

    if (jobName === 'deployment.status') {
      await handleDeploymentStatus(detail as DeploymentStatusEvent);
      return;
    }

    console.log(`Ignoring job type: ${jobName}`);
  } catch (error) {
    const structuredError = createStructuredError(
      error instanceof Error ? error : new Error('Unknown error'),
      {
        context: 'github-integration-processor',
        jobName,
        executionId: detail.executionId,
      }
    );
    console.error('Error in github-integration processor:', JSON.stringify(structuredError));
    throw error;
  }
}

async function fetchFindingsFromStorage(s3Key: string): Promise<Finding[]> {
  const analysisBucket = getConfigOptional('ANALYSIS_RESULTS_BUCKET');
  if (!analysisBucket) {
    console.warn('ANALYSIS_RESULTS_BUCKET not configured — cannot fetch findings from storage');
    return [];
  }
  const body = await getObject(analysisBucket, s3Key);
  if (!body) {
    throw new Error(`Empty storage response for key: ${s3Key}`);
  }
  const parsed = JSON.parse(body) as { findings: unknown[] };
  const findings = z
    .array(FindingSchema)
    .safeParse(Array.isArray(parsed.findings) ? parsed.findings : []);
  if (!findings.success) {
    console.warn(
      '[github-integration] Storage findings failed validation — returning empty array',
      {
        s3Key,
        errors: findings.error.issues,
      }
    );
    return [];
  }
  return findings.data;
}

async function handleAnalysisComplete(detail: AnalysisCompleteData): Promise<void> {
  const config = getDeploymentConfig();
  console.log(`Posting results for PR #${detail.prNumber} in ${detail.repoFullName}`);
  const db = getDb();

  // Fetch execution record for checkpoint data
  const [execution] = await db
    .select({ checkpoints: schema.executions.checkpoints })
    .from(schema.executions)
    .where(eq(schema.executions.executionId, detail.executionId))
    .limit(1);

  const checkpoints = execution?.checkpoints;
  const checkpoint1 = Array.isArray(checkpoints)
    ? (checkpoints[0] as ValidatedCheckpointRecord | undefined)
    : undefined;

  const dashboardUrl = getConfigOptional('DASHBOARD_URL') ?? '';

  // Fetch findings from storage if s3Key present (lightweight event path)
  const findings: Finding[] = detail.s3Key
    ? await fetchFindingsFromStorage(detail.s3Key)
    : ((detail.findings as Finding[] | undefined) ?? []);
  const resolvedDetail: AnalysisCompleteData = { ...detail, findings };

  // Initialize GitHub client
  const octokit = await getOctokitClient(detail.repoFullName);

  // Post PR comment
  const commentBody = buildCommentBody(resolvedDetail, { checkpoint: checkpoint1, dashboardUrl });
  const [owner, repo] = detail.repoFullName.split('/');

  await retryWithBackoff(
    async () => {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: detail.prNumber,
        body: commentBody,
      });
    },
    { maxAttempts: 3, baseDelayMs: 1000 }
  );

  console.log(`Successfully posted comment to PR #${detail.prNumber}`);

  // Auto-approve if low risk
  if (detail.riskScore < config.autoApproveRiskThreshold) {
    try {
      await retryWithBackoff(
        async () => {
          await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: detail.prNumber,
            event: 'APPROVE',
            body: 'Auto-approved by Pullmint: Low risk changes detected.',
          });
        },
        { maxAttempts: 3, baseDelayMs: 1000 }
      );
      console.log(`Auto-approved PR #${detail.prNumber}`);
    } catch (error) {
      console.error('Failed to auto-approve PR:', error);
    }
  }

  // Trigger deployment if gate passes
  await maybeTriggerDeployment(resolvedDetail, config);
}

async function handleDeploymentStatus(detail: DeploymentStatusEvent): Promise<void> {
  const db = getDb();
  const [owner, repo] = detail.repoFullName.split('/');
  const octokit = await getOctokitClient(detail.repoFullName);

  const metadataUpdates: Record<string, unknown> = {
    deploymentStatus: detail.deploymentStatus,
    deploymentEnvironment: detail.deploymentEnvironment,
    deploymentStrategy: detail.deploymentStrategy,
  };
  if (detail.message !== undefined) {
    metadataUpdates.deploymentMessage = detail.message;
  }

  const baseSet: Record<string, unknown> = {
    metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadataUpdates)}::jsonb`,
    updatedAt: new Date(),
  };

  let newStatus: string | null = null;

  if (detail.deploymentStatus === 'deploying') {
    newStatus = 'deploying';
    baseSet.deploymentStartedAt = new Date().toISOString();
  } else if (detail.deploymentStatus === 'deployed') {
    newStatus = 'monitoring';
    baseSet.deploymentCompletedAt = new Date().toISOString();
  } else if (detail.deploymentStatus === 'failed') {
    newStatus = 'failed';
    baseSet.deploymentCompletedAt = new Date().toISOString();
  }

  if (newStatus) {
    baseSet.status = newStatus;
  }

  // Conditional update: only advance if status is in allowed prior states
  const validPriorStatuses: Record<string, string[]> = {
    deploying: ['completed', 'pending', 'analyzing'],
    deployed: ['deploying'],
    failed: ['deploying', 'deployed', 'monitoring'],
  };

  const allowedPriors = validPriorStatuses[detail.deploymentStatus];

  let updated = false;
  if (allowedPriors) {
    const result = await db
      .update(schema.executions)
      .set(baseSet)
      .where(
        and(
          eq(schema.executions.executionId, detail.executionId),
          inArray(schema.executions.status, allowedPriors)
        )
      )
      .returning({ executionId: schema.executions.executionId });
    updated = result.length > 0;

    if (updated) {
      const eventStatus = baseSet.status;
      if (typeof eventStatus === 'string') {
        const event: ExecutionUpdateEvent = {
          executionId: detail.executionId,
          repoFullName: detail.repoFullName,
          prNumber: detail.prNumber,
          status: eventStatus,
          riskScore: (detail as { riskScore?: number }).riskScore ?? null,
          updatedAt: Date.now(),
        };
        await publishEvent(event);
      }
    }
  } else {
    await publishExecutionUpdate(detail.executionId, baseSet);
    updated = true;
  }

  if (!updated) {
    console.warn(
      `Status already advanced past ${detail.deploymentStatus} for ${detail.executionId} — skipping update`
    );
    return;
  }

  if (detail.deploymentStatus === 'deployed' || detail.deploymentStatus === 'failed') {
    const body = buildDeploymentStatusComment(detail);
    await retryWithBackoff(
      async () => {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: detail.prNumber,
          body,
        });
      },
      { maxAttempts: 3, baseDelayMs: 1000 }
    );
  }
}

async function maybeTriggerDeployment(
  detail: AnalysisCompleteData,
  config: DeploymentConfig
): Promise<void> {
  const db = getDb();

  if (detail.riskScore >= config.deploymentRiskThreshold) {
    console.log(
      `Deployment blocked: risk score ${detail.riskScore} >= ${config.deploymentRiskThreshold}`
    );
    await publishExecutionUpdate(detail.executionId, {
      status: 'deployment-blocked',
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
        deploymentMessage: `Risk score ${detail.riskScore} exceeds threshold ${config.deploymentRiskThreshold}`,
      })}::jsonb`,
    });
    return;
  }

  const [owner, repo] = detail.repoFullName.split('/');
  const octokit = await getOctokitClient(detail.repoFullName);

  if (config.deploymentRequireTests) {
    const checksPassed = await retryWithBackoff(
      async () =>
        areRequiredChecksPassing(
          octokit,
          owner,
          repo,
          detail.headSha,
          config.deploymentRequiredContexts
        ),
      { maxAttempts: 3, baseDelayMs: 1000 }
    );

    if (!checksPassed) {
      console.log('Deployment blocked: tests required but not passing.');
      await publishExecutionUpdate(detail.executionId, {
        status: 'deployment-blocked',
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          deploymentMessage: 'Tests required but not passing',
        })}::jsonb`,
      });
      return;
    }
  }

  // Idempotency: only proceed if not yet approved (deploymentApprovedAt not set in metadata)
  const result = await db
    .update(schema.executions)
    .set({
      status: 'deploying',
      deploymentStrategy: config.deploymentStrategy,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
        deploymentStatus: 'deploying',
        deploymentEnvironment: config.deploymentEnvironment,
        deploymentApprovedAt: new Date().toISOString(),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.executions.executionId, detail.executionId),
        isNull(sql`metadata->>'deploymentApprovedAt'`)
      )
    )
    .returning({ executionId: schema.executions.executionId });

  if (result.length === 0) {
    console.log(`Deployment already approved for execution ${detail.executionId}, skipping.`);
    return;
  }

  const deployingEvent: ExecutionUpdateEvent = {
    executionId: detail.executionId,
    repoFullName: detail.repoFullName,
    prNumber: detail.prNumber,
    status: 'deploying',
    riskScore: detail.riskScore ?? null,
    updatedAt: Date.now(),
  };
  await publishEvent(deployingEvent);

  try {
    if (config.deploymentStrategy === 'eventbridge') {
      const eventDetail: DeploymentApprovedEvent = {
        ...detail,
        executionId: detail.executionId,
        riskScore: detail.riskScore,
        deploymentEnvironment: config.deploymentEnvironment,
        deploymentStrategy: config.deploymentStrategy,
      };
      await addJob(
        QUEUE_NAMES.DEPLOYMENT,
        'deployment_approved',
        eventDetail as unknown as Record<string, unknown>
      );
      console.log(`Deployment approved for PR #${detail.prNumber}`);
      return;
    }

    if (config.deploymentStrategy === 'label') {
      await retryWithBackoff(
        async () => {
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: detail.prNumber,
            labels: [config.deploymentLabel],
          });
        },
        { maxAttempts: 3, baseDelayMs: 1000 }
      );
      console.log(`Deployment label added: ${config.deploymentLabel}`);
      return;
    }

    await retryWithBackoff(
      async () => {
        await octokit.rest.repos.createDeployment({
          owner,
          repo,
          ref: detail.headSha,
          environment: config.deploymentEnvironment,
          auto_merge: false,
          required_contexts: config.deploymentRequiredContexts,
          payload: {
            executionId: detail.executionId,
            prNumber: detail.prNumber,
            repoFullName: detail.repoFullName,
            deploymentStrategy: config.deploymentStrategy,
            baseSha: detail.baseSha,
            author: detail.author,
            title: detail.title,
            orgId: detail.orgId,
          },
        });
      },
      { maxAttempts: 3, baseDelayMs: 1000 }
    );
    console.log('Deployment created via GitHub Deployments API');
  } catch (error) {
    console.error('Failed to trigger deployment:', error);
    await publishExecutionUpdate(detail.executionId, {
      status: 'failed',
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
        deploymentStatus: 'failed',
        deploymentMessage: `Deployment trigger failed: ${error instanceof Error ? error.message : String(error)}`,
      })}::jsonb`,
      deploymentCompletedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function areRequiredChecksPassing(
  octokit: Awaited<ReturnType<typeof getGitHubInstallationClient>>,
  owner: string,
  repo: string,
  ref: string,
  requiredContexts: string[]
): Promise<boolean> {
  const response = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref });
  const statuses = response.data.statuses ?? [];

  if (requiredContexts.length === 0) {
    return response.data.state === 'success';
  }

  const statusByContext = new Map<string, string>();
  for (const status of statuses) {
    if (status.context && status.state) {
      statusByContext.set(status.context, status.state);
    }
  }
  return requiredContexts.every((ctx) => statusByContext.get(ctx) === 'success');
}

async function getOctokitClient(repoFullName: string) {
  let client = octokitClients.get(repoFullName);
  if (!client) {
    client = await getGitHubInstallationClient(repoFullName);
    octokitClients.set(repoFullName, client);
  }
  return client;
}

function getDeploymentConfig(): DeploymentConfig {
  let parsedConfig: Partial<DeploymentConfig> = {};
  const raw = getConfigOptional('DEPLOYMENT_CONFIG');
  if (raw) {
    try {
      parsedConfig = JSON.parse(raw) as Partial<DeploymentConfig>;
    } catch (error) {
      console.error('Invalid DEPLOYMENT_CONFIG JSON, falling back to individual env vars:', error);
    }
  }

  const rawRequiredContexts =
    Array.isArray(parsedConfig.deploymentRequiredContexts) &&
    parsedConfig.deploymentRequiredContexts.length > 0
      ? parsedConfig.deploymentRequiredContexts
      : parseCsv(getConfigOptional('DEPLOYMENT_REQUIRED_CONTEXTS') ?? '');

  return {
    deploymentRiskThreshold: Number(
      parsedConfig.deploymentRiskThreshold ?? getConfigOptional('DEPLOYMENT_RISK_THRESHOLD') ?? '30'
    ),
    autoApproveRiskThreshold: Number(
      parsedConfig.autoApproveRiskThreshold ??
        getConfigOptional('AUTO_APPROVE_RISK_THRESHOLD') ??
        '30'
    ),
    deploymentStrategy: (parsedConfig.deploymentStrategy ||
      getConfigOptional('DEPLOYMENT_STRATEGY') ||
      'eventbridge') as DeploymentConfig['deploymentStrategy'],
    deploymentLabel:
      parsedConfig.deploymentLabel || getConfigOptional('DEPLOYMENT_LABEL') || 'deploy:staging',
    deploymentEnvironment:
      parsedConfig.deploymentEnvironment ||
      getConfigOptional('DEPLOYMENT_ENVIRONMENT') ||
      'staging',
    deploymentRequireTests:
      parsedConfig.deploymentRequireTests ??
      (getConfigOptional('DEPLOYMENT_REQUIRE_TESTS') ?? 'false') === 'true',
    deploymentRequiredContexts: rawRequiredContexts,
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function buildCommentBody(analysis: AnalysisCompleteData, opts?: CommentOpts): string {
  const { findings, riskScore, metadata } = analysis;
  let body = `## Pullmint Analysis Results\n\n`;

  const riskLevel = getRiskLevel(riskScore);
  const riskEmoji = getRiskEmoji(riskLevel);
  body += `**Risk Score:** ${riskScore}/100 ${riskEmoji} (${riskLevel})\n\n`;

  if (opts?.checkpoint) {
    const pct = Math.round(opts.checkpoint.confidence * 100);
    body += `**Confidence:** ${pct}%\n\n`;
    if (opts.checkpoint.missingSignals.length > 0) {
      body += `_Missing signals:_ ${opts.checkpoint.missingSignals.join(', ')}\n\n`;
    }
  }

  if (metadata?.cached) {
    body += `_Analysis completed in ${metadata.processingTime}ms (cached)_\n\n`;
  } else if (metadata) {
    body += `_Analysis completed in ${metadata.processingTime}ms using ${metadata.tokensUsed} tokens_\n\n`;
  }

  if (!findings || findings.length === 0) {
    body += `### No Issues Found\n\nGreat work! No architecture or design issues detected.\n\n`;
  } else {
    body += `### Findings (${findings.length})\n\n`;
    const groups = [
      { label: 'Critical', items: findings.filter((f) => f.severity === 'critical'), emoji: '🔴' },
      { label: 'High', items: findings.filter((f) => f.severity === 'high'), emoji: '🟠' },
      { label: 'Medium', items: findings.filter((f) => f.severity === 'medium'), emoji: '🟡' },
      { label: 'Low', items: findings.filter((f) => f.severity === 'low'), emoji: '🔵' },
      { label: 'Info', items: findings.filter((f) => f.severity === 'info'), emoji: '⚪' },
    ];
    for (const group of groups) {
      if (group.items.length > 0) {
        body += `#### ${group.emoji} ${group.label} (${group.items.length})\n\n`;
        for (const finding of group.items) {
          body += `**${finding.title}**\n\n${finding.description}\n\n`;
          if (finding.suggestion) {
            body += `_Suggestion:_ ${finding.suggestion}\n\n`;
          }
          body += `---\n\n`;
        }
      }
    }
  }

  body += `\n---\n`;
  const execUrl = opts?.dashboardUrl
    ? `${opts.dashboardUrl}/executions/${analysis.executionId}`
    : '#';
  body += `<sub>Powered by Pullmint | [View Execution Details](${execUrl})</sub>`;
  return body;
}

export function getRiskLevel(score: number): string {
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

export function getRiskEmoji(level: string): string {
  switch (level) {
    case 'High':
      return '🔴';
    case 'Medium':
      return '🟡';
    default:
      return '🟢';
  }
}

function buildDeploymentStatusComment(detail: DeploymentStatusEvent): string {
  const statusLine = detail.deploymentStatus.toUpperCase();
  const message = detail.message ? `\n\n${detail.message}` : '';
  return [
    '## Pullmint Deployment Status',
    '',
    `**Status:** ${statusLine}`,
    `**Environment:** ${detail.deploymentEnvironment}`,
    `**Strategy:** ${detail.deploymentStrategy}`,
    message,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
