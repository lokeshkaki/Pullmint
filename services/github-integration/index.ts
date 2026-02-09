import { EventBridgeHandler } from 'aws-lambda';
import { getGitHubInstallationClient } from '../shared/github-app';
import { updateItem } from '../shared/dynamodb';
import { PREvent, AnalysisResult } from '../shared/types';

let octokitClient: Awaited<ReturnType<typeof getGitHubInstallationClient>> | undefined;

const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;

type DeploymentConfig = {
  enabled: boolean;
  strategy: 'label' | 'deployment';
  label: string;
  environment: string;
  riskThreshold: number;
  autoApprovalThreshold: number;
};

const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  enabled: true,
  strategy: 'label',
  label: 'deploy:staging',
  environment: 'staging',
  riskThreshold: 30,
  autoApprovalThreshold: 30,
};

const deploymentConfig = loadDeploymentConfig();

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
    if (detail.riskScore < deploymentConfig.autoApprovalThreshold) {
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
    if (deploymentConfig.enabled && detail.riskScore < deploymentConfig.riskThreshold) {
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
    deploymentStrategy: deploymentConfig.strategy,
    deploymentEnvironment: deploymentConfig.environment,
    deploymentStatus: 'queued',
    deploymentUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (deploymentConfig.strategy === 'label') {
    await octokitClient.rest.issues.addLabels({
      owner,
      repo,
      issue_number: detail.prNumber,
      labels: [deploymentConfig.label],
    });

    await updateItem(EXECUTIONS_TABLE_NAME, { executionId: detail.executionId }, deploymentBase);
    return;
  }

  const deployment = await octokitClient.rest.repos.createDeployment({
    owner,
    repo,
    ref: detail.headSha,
    required_contexts: [],
    environment: deploymentConfig.environment,
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

  await updateItem(
    EXECUTIONS_TABLE_NAME,
    { executionId: detail.executionId },
    {
      ...deploymentBase,
      deploymentId: deployment.data.id,
    }
  );
}

function loadDeploymentConfig(): DeploymentConfig {
  const rawConfig = process.env.PULLMINT_DEPLOYMENT_CONFIG;
  if (rawConfig) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConfig);
    } catch (error) {
      throw new Error('Invalid PULLMINT_DEPLOYMENT_CONFIG JSON');
    }

    return normalizeDeploymentConfig(parsed);
  }

  return normalizeDeploymentConfig({
    enabled: process.env.DEPLOYMENT_ENABLED,
    strategy: process.env.DEPLOYMENT_STRATEGY,
    label: process.env.DEPLOYMENT_LABEL,
    environment: process.env.DEPLOYMENT_ENVIRONMENT,
    riskThreshold: process.env.DEPLOYMENT_RISK_THRESHOLD,
    autoApprovalThreshold: process.env.AUTO_APPROVAL_THRESHOLD,
  });
}

function normalizeDeploymentConfig(input: unknown): DeploymentConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('Deployment config must be an object');
  }

  const config = input as Record<string, unknown>;

  return {
    enabled: parseBooleanValue(config.enabled, 'enabled', DEFAULT_DEPLOYMENT_CONFIG.enabled),
    strategy: parseStrategyValue(config.strategy, 'strategy', DEFAULT_DEPLOYMENT_CONFIG.strategy),
    label: parseStringValue(config.label, 'label', DEFAULT_DEPLOYMENT_CONFIG.label),
    environment: parseStringValue(
      config.environment,
      'environment',
      DEFAULT_DEPLOYMENT_CONFIG.environment
    ),
    riskThreshold: parseNumberValue(
      config.riskThreshold,
      'riskThreshold',
      DEFAULT_DEPLOYMENT_CONFIG.riskThreshold
    ),
    autoApprovalThreshold: parseNumberValue(
      config.autoApprovalThreshold,
      'autoApprovalThreshold',
      DEFAULT_DEPLOYMENT_CONFIG.autoApprovalThreshold
    ),
  };
}

function parseBooleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }

  throw new Error(`Deployment config ${label} must be a boolean.`);
}

function parseStrategyValue(
  value: unknown,
  label: string,
  fallback: DeploymentConfig['strategy']
): DeploymentConfig['strategy'] {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'label' || value === 'deployment') {
    return value;
  }

  throw new Error(`Deployment config ${label} must be "label" or "deployment".`);
}

function parseStringValue(value: unknown, label: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Deployment config ${label} must be a non-empty string.`);
}

function parseNumberValue(value: unknown, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new Error(`Deployment config ${label} must be a number.`);
  }

  if (parsed < 0 || parsed > 100) {
    throw new Error(`Deployment config ${label} must be between 0 and 100.`);
  }

  return parsed;
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
