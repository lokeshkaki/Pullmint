import { EventBridgeHandler } from 'aws-lambda';
import { getGitHubInstallationClient } from '../shared/github-app';
import { publishEvent } from '../shared/eventbridge';
import { updateItem, updateItemConditional } from '../shared/dynamodb';
import {
  PREvent,
  AnalysisResult,
  DeploymentApprovedEvent,
  DeploymentStatusEvent,
} from '../shared/types';

let octokitClient: Awaited<ReturnType<typeof getGitHubInstallationClient>> | undefined;
let octokitRepoFullName: string | undefined;

interface AnalysisCompleteEvent extends PREvent, AnalysisResult {}

/**
 * GitHub Integration Handler
 * Posts analysis results as PR comments
 */
export const handler: EventBridgeHandler<
  string,
  AnalysisCompleteEvent | DeploymentStatusEvent,
  void
> = async (event): Promise<void> => {
  try {
    const detailType = event['detail-type'];
    const { detail } = event;

    if (detailType === 'analysis.complete') {
      await handleAnalysisComplete(detail as AnalysisCompleteEvent);
      return;
    }

    if (detailType === 'deployment.status') {
      await handleDeploymentStatus(detail as DeploymentStatusEvent);
      return;
    }

    console.log(`Ignoring event detail type: ${detailType}`);
    return;
  } catch (error) {
    console.error('Error posting to GitHub:', error);
    throw error;
  }
};

async function handleAnalysisComplete(detail: AnalysisCompleteEvent): Promise<void> {
  const config = getDeploymentConfig();
  console.log(`Posting results for PR #${detail.prNumber} in ${detail.repoFullName}`);

  // 1. Initialize GitHub client
  const octokit = await getOctokitClient(detail.repoFullName);

  // 2. Build comment body
  const commentBody = buildCommentBody(detail);

  // 3. Post comment to PR
  const [owner, repo] = detail.repoFullName.split('/');

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: detail.prNumber,
    body: commentBody,
  });

  console.log(`Successfully posted comment to PR #${detail.prNumber}`);

  // 4. If low risk, approve the PR
  if (detail.riskScore < config.autoApproveRiskThreshold) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: detail.prNumber,
        event: 'APPROVE',
        body: 'Auto-approved by Pullmint: Low risk changes detected.',
      });
      console.log(`Auto-approved PR #${detail.prNumber}`);
    } catch (error) {
      console.error('Failed to auto-approve PR:', error);
      // Non-fatal - continue execution
    }
  }

  // 5. Trigger deployment if gate passes
  await maybeTriggerDeployment(detail, config);
}

async function handleDeploymentStatus(detail: DeploymentStatusEvent): Promise<void> {
  const config = getDeploymentConfig();
  const [owner, repo] = detail.repoFullName.split('/');
  const octokit = await getOctokitClient(detail.repoFullName);

  const updates: Record<string, unknown> = {
    deploymentStatus: detail.deploymentStatus,
    deploymentEnvironment: detail.deploymentEnvironment,
    deploymentStrategy: detail.deploymentStrategy,
    updatedAt: Date.now(),
  };

  if (detail.message !== undefined) {
    updates.deploymentMessage = detail.message;
  }

  if (detail.deploymentStatus === 'deploying') {
    updates.status = 'deploying';
    updates.deploymentStartedAt = Date.now();
  }

  if (detail.deploymentStatus === 'deployed') {
    updates.status = 'deployed';
    updates.deploymentCompletedAt = Date.now();
  }

  if (detail.deploymentStatus === 'failed') {
    updates.status = 'failed';
    updates.deploymentCompletedAt = Date.now();
  }

  // TODO: Implement optimistic locking for concurrent updates (see Pullmint PR #13 review)
  // Add version field to PRExecution and use conditional updates to prevent race conditions
  await updateItem(config.executionsTableName, { executionId: detail.executionId }, updates);

  if (detail.deploymentStatus === 'deployed' || detail.deploymentStatus === 'failed') {
    const body = buildDeploymentStatusComment(detail);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: detail.prNumber,
      body,
    });
  }
}

async function maybeTriggerDeployment(
  detail: AnalysisCompleteEvent,
  config: DeploymentConfig
): Promise<void> {
  if (detail.riskScore >= config.deploymentRiskThreshold) {
    console.log(
      `Deployment blocked: risk score ${detail.riskScore} >= ${config.deploymentRiskThreshold}`
    );
    return;
  }

  const [owner, repo] = detail.repoFullName.split('/');
  const octokit = await getOctokitClient(detail.repoFullName);

  if (config.deploymentRequireTests && detail.testsPassed !== true) {
    const checksPassed = await areRequiredChecksPassing(
      octokit,
      owner,
      repo,
      detail.headSha,
      config.deploymentRequiredContexts
    );

    if (!checksPassed) {
      console.log('Deployment blocked: tests required but not marked as passed.');
      return;
    }
  }

  // Record deployment approval timestamp
  try {
    await updateItemConditional(
      config.executionsTableName,
      { executionId: detail.executionId },
      {
        status: 'deploying',
        deploymentStatus: 'deploying',
        deploymentEnvironment: config.deploymentEnvironment,
        deploymentStrategy: config.deploymentStrategy,
        deploymentApprovedAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        conditionExpression: 'attribute_not_exists(#deploymentApprovedAt)',
        conditionAttributeNames: { '#deploymentApprovedAt': 'deploymentApprovedAt' },
      }
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log(`Deployment already approved for execution ${detail.executionId}, skipping.`);
      return;
    }
    throw error;
  }

  try {
    if (config.deploymentStrategy === 'eventbridge') {
      if (!config.eventBusName) {
        throw new Error('EVENT_BUS_NAME is required for eventbridge deployment strategy');
      }

      const eventDetail: DeploymentApprovedEvent = {
        ...detail,
        executionId: detail.executionId,
        riskScore: detail.riskScore,
        deploymentEnvironment: config.deploymentEnvironment,
        deploymentStrategy: config.deploymentStrategy,
      };

      await publishEvent(
        config.eventBusName,
        'pullmint.review',
        'deployment_approved',
        eventDetail as unknown as Record<string, unknown>
      );
      console.log(`Deployment approved for PR #${detail.prNumber}`);
      return;
    }

    if (config.deploymentStrategy === 'label') {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: detail.prNumber,
        labels: [config.deploymentLabel],
      });
      console.log(`Deployment label added: ${config.deploymentLabel}`);
      return;
    }

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
    console.log('Deployment created via GitHub Deployments API');
  } catch (error) {
    console.error('Failed to trigger deployment:', error);
    // Revert execution status if deployment trigger fails
    await updateItem(
      config.executionsTableName,
      { executionId: detail.executionId },
      {
        status: 'failed',
        deploymentStatus: 'failed',
        deploymentMessage: `Deployment trigger failed: ${error instanceof Error ? error.message : String(error)}`,
        deploymentCompletedAt: Date.now(),
        updatedAt: Date.now(),
      }
    );
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
  const response = await octokit.rest.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref,
  });

  const statuses = response.data.statuses || [];

  if (requiredContexts.length === 0) {
    return response.data.state === 'success';
  }

  const statusByContext = new Map<string, string>();
  for (const status of statuses) {
    if (status.context && status.state) {
      statusByContext.set(status.context, status.state);
    }
  }

  return requiredContexts.every((context) => statusByContext.get(context) === 'success');
}

async function getOctokitClient(repoFullName: string) {
  if (!octokitClient || octokitRepoFullName !== repoFullName) {
    octokitClient = await getGitHubInstallationClient(repoFullName);
    octokitRepoFullName = repoFullName;
  }
  return octokitClient;
}

/**
 * Build the PR comment body from analysis results
 */
export function buildCommentBody(analysis: AnalysisCompleteEvent): string {
  const { findings, riskScore, metadata } = analysis;

  // Header
  let body = `## Pullmint Analysis Results\n\n`;

  // Risk score badge
  const riskLevel = getRiskLevel(riskScore);
  const riskEmoji = getRiskEmoji(riskLevel);
  body += `**Risk Score:** ${riskScore}/100 ${riskEmoji} (${riskLevel})\n\n`;

  // Metadata
  if (metadata.cached) {
    body += `_Analysis completed in ${metadata.processingTime}ms (cached)_\n\n`;
  } else {
    body += `_Analysis completed in ${metadata.processingTime}ms using ${metadata.tokensUsed} tokens_\n\n`;
  }

  // Findings
  if (findings.length === 0) {
    body += `### No Issues Found\n\nGreat work! No architecture or design issues detected.\n\n`;
  } else {
    body += `### Findings (${findings.length})\n\n`;

    // Group findings by severity
    const critical = findings.filter((f) => f.severity === 'critical');
    const high = findings.filter((f) => f.severity === 'high');
    const medium = findings.filter((f) => f.severity === 'medium');
    const low = findings.filter((f) => f.severity === 'low');
    const info = findings.filter((f) => f.severity === 'info');

    const groups = [
      { label: 'Critical', items: critical, emoji: '🔴' },
      { label: 'High', items: high, emoji: '🟠' },
      { label: 'Medium', items: medium, emoji: '🟡' },
      { label: 'Low', items: low, emoji: '🔵' },
      { label: 'Info', items: info, emoji: '⚪' },
    ];

    for (const group of groups) {
      if (group.items.length > 0) {
        body += `#### ${group.emoji} ${group.label} (${group.items.length})\n\n`;

        for (const finding of group.items) {
          body += `**${finding.title}**\n\n`;
          body += `${finding.description}\n\n`;

          if (finding.suggestion) {
            body += `_Suggestion:_ ${finding.suggestion}\n\n`;
          }

          body += `---\n\n`;
        }
      }
    }
  }

  // Footer
  body += `\n---\n`;
  body += `<sub>Powered by Pullmint | [View Execution Details](#)</sub>`;

  return body;
}

/**
 * Get risk level from score
 */
export function getRiskLevel(score: number): string {
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

/**
 * Get emoji for risk level
 */
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
  const environment = detail.deploymentEnvironment;
  const strategy = detail.deploymentStrategy;
  const message = detail.message ? `\n\n${detail.message}` : '';

  return [
    '## Pullmint Deployment Status',
    '',
    `**Status:** ${statusLine}`,
    `**Environment:** ${environment}`,
    `**Strategy:** ${strategy}`,
    message,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

type DeploymentConfig = {
  deploymentRiskThreshold: number;
  autoApproveRiskThreshold: number;
  deploymentStrategy: 'eventbridge' | 'label' | 'deployment';
  deploymentLabel: string;
  deploymentEnvironment: string;
  deploymentRequireTests: boolean;
  deploymentRequiredContexts: string[];
  eventBusName?: string;
  executionsTableName: string;
};

function getDeploymentConfig(): DeploymentConfig {
  const executionsTableName = process.env.EXECUTIONS_TABLE_NAME;
  if (!executionsTableName) {
    throw new Error('EXECUTIONS_TABLE_NAME is required');
  }

  let parsedConfig: Partial<DeploymentConfig> = {};
  if (process.env.DEPLOYMENT_CONFIG) {
    try {
      parsedConfig = JSON.parse(process.env.DEPLOYMENT_CONFIG) as Partial<DeploymentConfig>;
    } catch (error) {
      console.error('Invalid DEPLOYMENT_CONFIG JSON, falling back to env vars:', error);
    }
  }

  const rawRequiredContexts =
    Array.isArray(parsedConfig.deploymentRequiredContexts) &&
    parsedConfig.deploymentRequiredContexts.length > 0
      ? parsedConfig.deploymentRequiredContexts
      : parseCsv(process.env.DEPLOYMENT_REQUIRED_CONTEXTS || '');

  return {
    deploymentRiskThreshold: Number(
      parsedConfig.deploymentRiskThreshold ?? process.env.DEPLOYMENT_RISK_THRESHOLD ?? '30'
    ),
    autoApproveRiskThreshold: Number(
      parsedConfig.autoApproveRiskThreshold ?? process.env.AUTO_APPROVE_RISK_THRESHOLD ?? '30'
    ),
    deploymentStrategy: (parsedConfig.deploymentStrategy ||
      process.env.DEPLOYMENT_STRATEGY ||
      'eventbridge') as 'eventbridge' | 'label' | 'deployment',
    deploymentLabel:
      parsedConfig.deploymentLabel || process.env.DEPLOYMENT_LABEL || 'deploy:staging',
    deploymentEnvironment:
      parsedConfig.deploymentEnvironment || process.env.DEPLOYMENT_ENVIRONMENT || 'staging',
    deploymentRequireTests:
      parsedConfig.deploymentRequireTests ??
      (process.env.DEPLOYMENT_REQUIRE_TESTS || 'false') === 'true',
    deploymentRequiredContexts: rawRequiredContexts,
    eventBusName: process.env.EVENT_BUS_NAME,
    executionsTableName,
  };
}
