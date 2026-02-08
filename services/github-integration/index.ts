import { EventBridgeHandler } from 'aws-lambda';
import { Octokit } from '@octokit/rest';
import { getSecret } from '../shared/secrets';
import { PREvent, AnalysisResult } from '../shared/types';

const GITHUB_APP_PRIVATE_KEY_ARN = process.env.GITHUB_APP_PRIVATE_KEY_ARN!;

let octokitClient: Octokit;

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
      const githubToken = await getSecret(GITHUB_APP_PRIVATE_KEY_ARN);
      octokitClient = new Octokit({ auth: githubToken });
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
    if (detail.riskScore < 30) {
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
  } catch (error) {
    console.error('Error posting to GitHub:', error);
    throw error;
  }
};

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
