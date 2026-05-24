import type { z } from 'zod/v4';
import type { PullmintClient } from './client';
import {
  executionInput,
  listPrAnalysesInput,
  repoInput,
  reEvaluationInput,
  triggerAnalysisInput,
} from './schemas';

type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject;
};

export const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: 'pullmint_list_pr_analyses',
    description: 'List stored Pullmint analysis runs for a pull request. Read only.',
    schema: listPrAnalysesInput,
  },
  {
    name: 'pullmint_get_analysis',
    description: 'Retrieve one stored Pullmint analysis and findings. Read only.',
    schema: executionInput,
  },
  {
    name: 'pullmint_get_analysis_evidence',
    description: 'Retrieve stored checkpoints and evidence for one analysis. Read only.',
    schema: executionInput,
  },
  {
    name: 'pullmint_get_repo_calibration',
    description: 'Retrieve stored Pullmint calibration data for a repository. Read only.',
    schema: repoInput,
  },
  {
    name: 'pullmint_record_re_evaluation',
    description:
      'Record a developer justification note on an existing analysis. This does not run analysis or generate findings.',
    schema: reEvaluationInput,
  },
  {
    name: 'pullmint_trigger_analysis',
    description:
      'Queue a fresh full Pullmint analysis. This can incur runtime cost, post a GitHub review, and proceed through configured deployment gating.',
    schema: triggerAnalysisInput,
  },
];

export async function runTool(
  client: PullmintClient,
  name: string,
  input: unknown
): Promise<unknown> {
  switch (name) {
    case 'pullmint_list_pr_analyses':
      return client.listPrAnalyses(listPrAnalysesInput.parse(input));
    case 'pullmint_get_analysis':
      return client.getAnalysis(executionInput.parse(input));
    case 'pullmint_get_analysis_evidence':
      return client.getAnalysisEvidence(executionInput.parse(input));
    case 'pullmint_get_repo_calibration':
      return client.getRepoCalibration(repoInput.parse(input));
    case 'pullmint_record_re_evaluation':
      return client.recordReEvaluation(reEvaluationInput.parse(input));
    case 'pullmint_trigger_analysis':
      return client.triggerAnalysis(triggerAnalysisInput.parse(input));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function asTextContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
