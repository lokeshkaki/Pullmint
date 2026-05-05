import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { filterFindingsBySeverity } from '../../services/shared/pullmint-config';
import type { Finding } from '../../services/shared/types';
import { isLineInDiff, parseDiff } from '../../services/workers/src/diff-filter';
import type { AnalysisRunResult, PRContext } from './run-analysis';

interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface PostReviewOptions {
  prContext: PRContext;
  githubToken: string;
  result: AnalysisRunResult;
  severityThreshold: string;
}

const MAX_INLINE_COMMENTS = 30;
const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export async function postReview(opts: PostReviewOptions): Promise<void> {
  const { prContext, githubToken, result, severityThreshold } = opts;
  const octokit = new Octokit({ auth: githubToken });
  const displayFindings = filterFindingsBySeverity(result.allFindings, severityThreshold);
  const parsedDiff = parseDiff(result.rawDiff);

  const inlineFindings: Array<Finding & { file: string; line: number }> = [];
  const bodyFindings: Finding[] = [];

  for (const finding of displayFindings) {
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

  inlineFindings.sort(
    (left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity)
  );

  const cappedInlineFindings = inlineFindings.slice(0, MAX_INLINE_COMMENTS);
  const overflowFindings = inlineFindings.slice(MAX_INLINE_COMMENTS);
  bodyFindings.push(...overflowFindings);

  const comments: ReviewComment[] = cappedInlineFindings.map((finding) => {
    const emoji = SEVERITY_EMOJI[finding.severity] ?? '⚪';
    let commentBody = `${emoji} **[${finding.type}]** ${finding.title}\n\n${finding.description}`;

    if (finding.suggestion) {
      commentBody += `\n\n**Suggestion:** ${finding.suggestion}`;
    }

    return {
      path: finding.file,
      line: finding.line,
      side: 'RIGHT',
      body: commentBody,
    };
  });

  const riskEmoji = result.riskScore >= 60 ? '🔴' : result.riskScore >= 30 ? '🟡' : '🟢';
  const successfulAgentCount = result.agentResults.filter(
    (agentResult) => agentResult.status === 'completed'
  ).length;
  const totalTokens = result.agentResults.reduce((sum, agentResult) => sum + agentResult.tokens, 0);

  let body = '## Pullmint Analysis Results\n\n';
  body += `**Risk Score:** ${riskEmoji} ${result.riskScore}/100\n\n`;

  if (result.summary) {
    body += `> ${result.summary}\n\n`;
  }

  body += `🤖 ${successfulAgentCount} agent${successfulAgentCount === 1 ? '' : 's'} | 🔤 ${totalTokens} tokens\n\n`;

  if (comments.length > 0) {
    body += `📝 ${comments.length} finding${comments.length === 1 ? '' : 's'} posted as inline comments.\n\n`;
  }

  if (bodyFindings.length > 0) {
    for (const severity of SEVERITY_ORDER) {
      const findingsForSeverity = bodyFindings.filter((finding) => finding.severity === severity);
      if (findingsForSeverity.length === 0) {
        continue;
      }

      const emoji = SEVERITY_EMOJI[severity] ?? '⚪';
      body += `### ${emoji} ${severity.charAt(0).toUpperCase() + severity.slice(1)}\n\n`;

      for (const finding of findingsForSeverity) {
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

  body += '_Powered by [Pullmint](https://github.com/lokeshkaki/pullmint)_\n';

  try {
    await octokit.rest.pulls.createReview({
      owner: prContext.owner,
      repo: prContext.repo,
      pull_number: prContext.prNumber,
      commit_id: prContext.headSha,
      event: 'COMMENT',
      body,
      comments: comments,
    });

    core.info(
      `Posted PR review with ${comments.length} inline comments and ${bodyFindings.length} body findings`
    );
  } catch (error) {
    core.warning(
      `Failed to post review with inline comments, retrying body-only: ${String(error)}`
    );

    await octokit.rest.pulls.createReview({
      owner: prContext.owner,
      repo: prContext.repo,
      pull_number: prContext.prNumber,
      event: 'COMMENT',
      body,
    });
  }
}
