import { EventBridgeHandler } from 'aws-lambda';
import { getGitHubInstallationClient } from '../shared/github-app';
import { updateItem } from '../shared/dynamodb';
import { PREvent, AnalysisResult } from '../shared/types';

let octokitClient: Awaited<ReturnType<typeof getGitHubInstallationClient>> | undefined;

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const AUTO_APPROVAL_THRESHOLD = Number(process.env.AUTO_APPROVAL_THRESHOLD || '30');
const DEPLOYMENT_RISK_THRESHOLD = Number(process.env.DEPLOYMENT_RISK_THRESHOLD || '30');
const DEPLOYMENT_STRATEGY = (process.env.DEPLOYMENT_STRATEGY || 'label') as
  | 'label'
  | 'deployment';
const DEPLOYMENT_LABEL = process.env.DEPLOYMENT_LABEL || 'deploy:staging';
const DEPLOYMENT_ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT || 'staging';
const DEPLOYMENT_ENABLED = (process.env.DEPLOYMENT_ENABLED || 'true') === 'true';

interface AnalysisCompleteEvent extends PREvent, AnalysisResult {}

/**
 * GitHub Integration Handler
 * Posts analysis results as PR comments
 */
export const handler: EventBridgeHandler<'analysis.complete', AnalysisCompleteEvent, void> = async (
  event
): Promise<void> => {
  try {
    const { detail } = event;

    console.log(`Posting results for PR #${detail.prNumber} in ${detail.repoFullName}`);

    // 1. Initialize GitHub client
    if (!octokitClient) {
      octokitClient = await getGitHubInstallationClient(detail.repoFullName);
    }

    // 2. Build comment body
    const commentBody = buildCommentBody(detail);

    // 3. Post comment to PR
    const [owner, repo] = detail.repoFullName.split('/');

    await octokitClient.rest.issues.createComment({
      owner,
      repo,
      issue_number: detail.prNumber,
      body: commentBody,
    });

    console.log(`Successfully posted comment to PR #${detail.prNumber}`);

    // 4. If low risk, approve the PR
    if (detail.riskScore < AUTO_APPROVAL_THRESHOLD) {
      try {
        await octokitClient.rest.pulls.createReview({
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

    // 5. If low risk and enabled, trigger deploy gate
    if (DEPLOYMENT_ENABLED && detail.riskScore < DEPLOYMENT_RISK_THRESHOLD) {
      await triggerDeployment(detail, owner, repo);
    }
  } catch (error) {
    console.error('Error posting to GitHub:', error);
    throw error;
  }
};

async function triggerDeployment(
  detail: AnalysisCompleteEvent,
  owner: string,
  repo: string
): Promise<void> {
  if (!octokitClient) {
    throw new Error('GitHub client not initialized');
  }

  const deploymentBase = {
    status: 'deploying',
    deploymentStrategy: DEPLOYMENT_STRATEGY,
    deploymentEnvironment: DEPLOYMENT_ENVIRONMENT,
    deploymentStatus: 'queued',
    deploymentUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (DEPLOYMENT_STRATEGY === 'label') {
    await octokitClient.rest.issues.addLabels({
      owner,
      repo,
      issue_number: detail.prNumber,
      labels: [DEPLOYMENT_LABEL],
    });

    await updateItem(EXECUTIONS_TABLE_NAME, { executionId: detail.executionId }, deploymentBase);
    return;
  }

  const deployment = await octokitClient.rest.repos.createDeployment({
    owner,
    repo,
    ref: detail.headSha,
    required_contexts: [],
    environment: DEPLOYMENT_ENVIRONMENT,
    transient_environment: true,
    auto_merge: false,
    description: 'Pullmint auto-deploy gate',
    payload: {
      executionId: detail.executionId,
      repoFullName: detail.repoFullName,
      prNumber: detail.prNumber,
      headSha: detail.headSha,
      riskScore: detail.riskScore,
    },
    production_environment: false,
  });

  await octokitClient.rest.repos.createDeploymentStatus({
    owner,
    repo,
    deployment_id: deployment.data.id,
    state: 'queued',
    description: 'Queued by Pullmint',
  });

  await updateItem(EXECUTIONS_TABLE_NAME, { executionId: detail.executionId }, {
    ...deploymentBase,
    deploymentId: deployment.data.id,
  });
}

/**
 * Build the PR comment body from analysis results
 */
function buildCommentBody(analysis: AnalysisCompleteEvent): string {
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
function getRiskLevel(score: number): string {
  if (score >= 70) return 'High';
  if (score >= 40) return 'Medium';
  return 'Low';
}

/**
 * Get emoji for risk level
 */
function getRiskEmoji(level: string): string {
  switch (level) {
    case 'High':
      return '🔴';
    case 'Medium':
      return '🟡';
    default:
      return '🟢';
  }
}

export const __test__ = {
  setOctokitClient: (client: typeof octokitClient) => {
    octokitClient = client;
  },
  triggerDeployment,
};
