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
import { parseDiff, isLineInDiff, ParsedDiff } from '../diff-filter';
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

interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

interface ReviewPayload {
  body: string;
  comments: ReviewComment[];
}

const MAX_INLINE_COMMENTS = 30;

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

  const analysisBucket = getConfigOptional('ANALYSIS_RESULTS_BUCKET') ?? 'pullmint-analysis';
  const diffKey = `diffs/${detail.executionId}.diff`;
  let parsedDiff: ParsedDiff = {
    files: [],
    totalFiles: 0,
    totalAddedLines: 0,
    totalRemovedLines: 0,
  };
  try {
    const rawDiff = await getObject(analysisBucket, diffKey);
    if (rawDiff) {
      parsedDiff = parseDiff(rawDiff);
    }
  } catch (err) {
    // If diff fetch fails, all findings go to body — graceful degradation
    console.warn(
      { err, executionId: detail.executionId },
      'Failed to fetch diff for inline comments'
    );
  }

  // Initialize GitHub client
  const octokit = await getOctokitClient(detail.repoFullName);

  // Post PR review with inline comments
  const payload = buildReviewPayload(resolvedDetail, parsedDiff, {
    checkpoint: checkpoint1,
    dashboardUrl: dashboardUrl ? `${dashboardUrl}/executions/${detail.executionId}` : undefined,
  });
  const [owner, repo] = detail.repoFullName.split('/');

  await retryWithBackoff(
    async () => {
      const createReview = octokit.rest.pulls.createReview as unknown as (
        params: Record<string, unknown>
      ) => Promise<unknown>;

      await createReview({
        owner,
        repo,
        pull_number: detail.prNumber,
        event: 'COMMENT',
        body: payload.body,
        comments: payload.comments,
      });
    },
    { maxAttempts: 3, baseDelayMs: 1000 }
  );

  console.log(`Successfully posted review to PR #${detail.prNumber}`);

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

function getSeverityEmoji(severity: string): string {
  const map: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
    info: '⚪',
  };
  return map[severity] ?? '⚪';
}

function groupBySeverity(findings: Finding[]): [string, Finding[]][] {
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!groups.has(finding.severity)) {
      groups.set(finding.severity, []);
    }
    groups.get(finding.severity)?.push(finding);
  }
  return order
    .filter((severity) => groups.has(severity))
    .map((severity) => [severity, groups.get(severity) ?? []]);
}

function buildReviewPayload(
  analysis: AnalysisCompleteData,
  parsedDiff: ParsedDiff,
  opts?: { checkpoint?: ValidatedCheckpointRecord; dashboardUrl?: string }
): ReviewPayload {
  const findings: Finding[] = analysis.findings ?? [];
  const riskScore = analysis.riskScore ?? 0;

  // Partition findings into inline-able vs body-only
  const inlineFindings: Array<Finding & { file: string; line: number }> = [];
  const bodyFindings: Finding[] = [];

  for (const finding of findings) {
    if (
      typeof finding.file === 'string' &&
      typeof finding.line === 'number' &&
      isLineInDiff(parsedDiff, finding.file, finding.line)
    ) {
      inlineFindings.push(finding as Finding & { file: string; line: number });
    } else {
      bodyFindings.push(finding);
    }
  }

  // Enforce inline comment cap — overflow lowest-severity to body
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  inlineFindings.sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  );

  const capped = inlineFindings.slice(0, MAX_INLINE_COMMENTS);
  const overflow = inlineFindings.slice(MAX_INLINE_COMMENTS);
  bodyFindings.push(...overflow);

  // Build inline comments
  const comments: ReviewComment[] = capped.map((finding) => {
    const severityEmoji = getSeverityEmoji(finding.severity);
    let commentBody = `${severityEmoji} **[${finding.type}]** ${finding.title}\n\n${finding.description}`;
    if (finding.suggestion) {
      commentBody += `\n\n**Suggestion:** ${finding.suggestion}`;
    }
    return { path: finding.file, line: finding.line, side: 'RIGHT', body: commentBody };
  });

  const riskEmoji = riskScore >= 60 ? '🔴' : riskScore >= 30 ? '🟡' : '🟢';
  let body = `## Pullmint Analysis Results\n\n`;
  body += `**Risk Score:** ${riskEmoji} ${riskScore}/100\n\n`;

  if (opts?.checkpoint) {
    const pct = Math.round(opts.checkpoint.confidence * 100);
    body += `**Confidence:** ${pct}%\n\n`;
    if (opts.checkpoint.missingSignals.length > 0) {
      body += `_Missing signals:_ ${opts.checkpoint.missingSignals.join(', ')}\n\n`;
    }
  }

  // Add metadata from analysis.metadata
  if (analysis.metadata) {
    const meta = analysis.metadata as unknown as Record<string, unknown>;
    const totalLatencyMs =
      typeof meta.totalLatencyMs === 'number'
        ? meta.totalLatencyMs
        : typeof meta.processingTime === 'number'
          ? meta.processingTime
          : undefined;
    const totalTokens =
      typeof meta.totalTokens === 'number'
        ? meta.totalTokens
        : typeof meta.tokensUsed === 'number'
          ? meta.tokensUsed
          : undefined;

    if (totalLatencyMs !== undefined) {
      body += `⏱️ ${totalLatencyMs}ms`;
    }
    if (totalTokens !== undefined) {
      body += ` | 🔤 ${totalTokens} tokens`;
    }
    if (meta.cached === true) {
      body += ` | 📦 cached`;
    }
    if (meta.incremental === true) {
      body += ` | 🔄 incremental`;
    }

    body += '\n\n';
  }

  if (comments.length > 0) {
    body += `📝 ${comments.length} finding${comments.length === 1 ? '' : 's'} posted as inline comments.\n\n`;
  }

  // Group remaining body findings by severity
  if (bodyFindings.length > 0) {
    const grouped = groupBySeverity(bodyFindings);
    for (const [severity, items] of grouped) {
      body += `### ${getSeverityEmoji(severity)} ${severity.charAt(0).toUpperCase() + severity.slice(1)}\n\n`;
      for (const finding of items) {
        body += `**${finding.title}**\n${finding.description}`;
        if (finding.suggestion) {
          body += `\n*Suggestion: ${finding.suggestion}*`;
        }
        body += '\n\n---\n\n';
      }
    }
  } else if (comments.length === 0) {
    body += '✅ No issues found.\n\n';
  }

  if (opts?.dashboardUrl) {
    body += `[View full analysis](${opts.dashboardUrl})\n`;
  }

  return { body, comments };
}

export function buildCommentBody(analysis: AnalysisCompleteData, opts?: CommentOpts): string {
  const parsedDiff: ParsedDiff = {
    files: [],
    totalFiles: 0,
    totalAddedLines: 0,
    totalRemovedLines: 0,
  };

  return buildReviewPayload(analysis, parsedDiff, {
    checkpoint: opts?.checkpoint,
    dashboardUrl: opts?.dashboardUrl
      ? `${opts.dashboardUrl}/executions/${analysis.executionId}`
      : undefined,
  }).body;
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
