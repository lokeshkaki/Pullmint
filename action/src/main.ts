import * as core from '@actions/core';
import * as github from '@actions/github';
import { postReview } from './post-review';
import { runAnalysis } from './run-analysis';

export async function run(): Promise<void> {
  try {
    const context = github.context;

    if (!context.payload.pull_request) {
      core.warning('This action is only meaningful in pull_request events. Skipping.');
      return;
    }

    const pr = context.payload.pull_request;
    const prData = pr as {
      number: number;
      title: string;
      head: { sha: string };
      base: { sha: string };
      user: { login: string };
    };
    const inputs = {
      anthropicApiKey: core.getInput('anthropic-api-key'),
      openaiApiKey: core.getInput('openai-api-key'),
      googleApiKey: core.getInput('google-api-key'),
      llmProvider: core.getInput('llm-provider') || 'anthropic',
      githubToken: core.getInput('github-token') || process.env.GITHUB_TOKEN || '',
      severityThreshold: core.getInput('severity-threshold') || 'low',
      configPath: core.getInput('config-path') || '.pullmint.yml',
      failOnRiskScore: core.getInput('fail-on-risk-score'),
      postReviewInput: core.getInput('post-review') !== 'false',
      agentsInput: core.getInput('agents') || 'all',
    };

    if (inputs.anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = inputs.anthropicApiKey;
    }
    if (inputs.openaiApiKey) {
      process.env.OPENAI_API_KEY = inputs.openaiApiKey;
    }
    if (inputs.googleApiKey) {
      process.env.GOOGLE_API_KEY = inputs.googleApiKey;
    }
    process.env.LLM_PROVIDER = inputs.llmProvider;

    const prContext = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      prNumber: prData.number,
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
      author: prData.user.login,
      title: prData.title,
    };

    core.info(`Running Pullmint analysis on PR #${prContext.prNumber}`);

    const result = await runAnalysis({
      prContext,
      githubToken: inputs.githubToken,
      severityThreshold: inputs.severityThreshold,
      configPath: inputs.configPath,
      agentsInput: inputs.agentsInput,
    });

    core.setOutput('risk-score', String(result.riskScore));
    core.setOutput('findings-count', String(result.findings.length));
    core.setOutput('findings-json', JSON.stringify(result.findings));

    core.info(
      `Analysis complete — Risk: ${result.riskScore}/100, Findings: ${result.findings.length}`
    );

    if (inputs.postReviewInput) {
      await postReview({
        prContext,
        githubToken: inputs.githubToken,
        result,
        severityThreshold: inputs.severityThreshold,
      });
    }

    if (inputs.failOnRiskScore) {
      const threshold = parseInt(inputs.failOnRiskScore, 10);
      if (!Number.isNaN(threshold) && result.riskScore >= threshold) {
        core.setFailed(
          `Risk score ${result.riskScore} meets or exceeds fail-on-risk-score threshold of ${threshold}`
        );
      }
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void run();
