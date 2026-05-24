import { z } from 'zod';

const ownerRepo = {
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
};

export const listPrAnalysesInput = z.object({
  ...ownerRepo,
  prNumber: z.number().int().positive(),
  limit: z.number().int().positive().max(100).default(10),
});
export const executionInput = z.object({ executionId: z.string().trim().min(1).max(300) });
export const repoInput = z.object(ownerRepo);
export const reEvaluationInput = executionInput.extend({
  justification: z.string().trim().min(1).max(500),
});
export const triggerAnalysisInput = z.object({
  ...ownerRepo,
  prNumber: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const executionSummary = z.object({
  executionId: z.string(),
  status: z.string(),
  headSha: z.string(),
  riskScore: z.number().nullable().optional(),
  createdAt: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const executionListResponse = z.object({
  executions: z.array(executionSummary),
  count: z.number(),
});
export const analysisResponse = z.object({
  executionId: z.string(),
  repoFullName: z.string(),
  prNumber: z.number(),
  status: z.string(),
  headSha: z.string(),
  riskScore: z.number().nullable().optional(),
  confidenceScore: z.number().nullable().optional(),
  findings: z.array(z.unknown()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  overrideHistory: z.array(z.unknown()).nullable().optional(),
});
export const evidenceResponse = z.object({
  executionId: z.string(),
  checkpoints: z.unknown().optional(),
  signalsReceived: z.unknown().optional(),
  repoContext: z.unknown().optional(),
  calibrationApplied: z.number().nullable().optional(),
});
export const calibrationResponse = z.object({
  repoFullName: z.string(),
  observationsCount: z.number().optional(),
  successCount: z.number().optional(),
  rollbackCount: z.number().optional(),
  falsePositiveCount: z.number().optional(),
  falseNegativeCount: z.number().optional(),
  calibrationFactor: z.number(),
  signalWeights: z.unknown().optional(),
  lastUpdatedAt: z.unknown().optional(),
});
export const acceptedActionResponse = z.object({ message: z.string() });
export const triggerResponse = z.object({
  message: z.string(),
  executionId: z.string(),
  repoFullName: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
  status: z.literal('pending'),
  costIncurred: z.literal(true),
});
