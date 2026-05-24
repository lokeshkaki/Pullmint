import type { z } from 'zod';
import type { PullmintMcpConfig } from './config';
import { mapHttpError, PullmintApiError } from './errors';
import {
  acceptedActionResponse,
  analysisResponse,
  calibrationResponse,
  evidenceResponse,
  executionListResponse,
  listPrAnalysesInput,
  reEvaluationInput,
  triggerAnalysisInput,
  triggerResponse,
} from './schemas';

type ListInput = z.infer<typeof listPrAnalysesInput>;
type ReEvaluationInput = z.infer<typeof reEvaluationInput>;
type TriggerInput = z.infer<typeof triggerAnalysisInput>;

export class PullmintClient {
  constructor(private readonly config: PullmintMcpConfig) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(`${this.config.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.authToken}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw mapHttpError(response.status);
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        throw new PullmintApiError(
          'Pullmint API returned an invalid response',
          'invalid_response'
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof PullmintApiError) {
        throw error;
      }
      throw new PullmintApiError('Pullmint self-hosted API is unavailable', 'api_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  listPrAnalyses(input: ListInput) {
    const value = listPrAnalysesInput.parse(input);
    return this.request(
      `/dashboard/repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.repo)}/prs/${value.prNumber}?limit=${value.limit}`,
      executionListResponse
    );
  }

  getAnalysis(input: { executionId: string }) {
    return this.request(
      `/dashboard/executions/${encodeURIComponent(input.executionId)}`,
      analysisResponse
    );
  }

  getAnalysisEvidence(input: { executionId: string }) {
    return this.request(
      `/dashboard/executions/${encodeURIComponent(input.executionId)}/checkpoints`,
      evidenceResponse
    );
  }

  getRepoCalibration(input: { owner: string; repo: string }) {
    return this.request(
      `/dashboard/calibration/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
      calibrationResponse
    );
  }

  recordReEvaluation(input: ReEvaluationInput) {
    const value = reEvaluationInput.parse(input);
    return this.request(
      `/dashboard/executions/${encodeURIComponent(value.executionId)}/re-evaluate`,
      acceptedActionResponse,
      {
        method: 'POST',
        body: JSON.stringify({ justification: value.justification }),
      }
    );
  }

  triggerAnalysis(input: TriggerInput) {
    const value = triggerAnalysisInput.parse(input);
    return this.request(
      `/dashboard/repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.repo)}/prs/${value.prNumber}/analyze`,
      triggerResponse,
      {
        method: 'POST',
        body: JSON.stringify(value.reason ? { reason: value.reason } : {}),
      }
    );
  }
}
