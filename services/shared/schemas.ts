import { z } from 'zod';

// --- Signal & Checkpoint ---

export const SignalSchema = z.object({
  signalType: z.enum([
    'production.error_rate',
    'production.latency',
    'deployment.status',
    'ci.coverage',
    'ci.result',
    'time_of_day',
    'author_history',
    'simultaneous_deploy',
  ]),
  value: z.union([z.number(), z.boolean()]),
  source: z.string(),
  timestamp: z.number(),
});

export const CheckpointRecordSchema = z.object({
  type: z.enum(['analysis', 'pre-deploy', 'post-deploy-5', 'post-deploy-30']),
  score: z.number(),
  confidence: z.number(),
  missingSignals: z.array(z.string()),
  signals: z.array(SignalSchema),
  decision: z.enum(['approved', 'held', 'rollback']),
  reason: z.string(),
  confirmedWithLowConfidence: z.boolean().optional(),
  evaluatedAt: z.number(),
});

// --- Finding ---

export const FindingSchema = z.object({
  type: z.enum(['architecture', 'security', 'performance', 'style']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(),
  description: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  suggestion: z.string().optional(),
});

// --- RepoContext ---

export const RepoContextSchema = z.object({
  isSharedDependency: z.boolean(),
  downstreamDependentCount: z.number(),
  blastRadiusMultiplier: z.number(),
  repoRollbackRate30d: z.number(),
  simultaneousDeploysInProgress: z.array(z.string()),
});

// --- PRExecution ---

export const PRExecutionSchema = z.object({
  executionId: z.string(),
  repoFullName: z.string(),
  repoPrKey: z.string().optional(),
  prNumber: z.number(),
  headSha: z.string(),
  status: z.enum([
    'pending',
    'analyzing',
    'completed',
    'failed',
    'deploying',
    'deployed',
    'deployment-blocked',
    'monitoring',
    'confirmed',
    'rolled-back',
  ]),
  timestamp: z.number().optional(),
  entityType: z.literal('execution').optional(),
  findings: z.array(FindingSchema).optional(),
  riskScore: z.number().optional(),
  error: z.string().optional(),
  updatedAt: z.number().optional(),
  deploymentStatus: z.enum(['deploying', 'deployed', 'failed']).optional(),
  deploymentEnvironment: z.string().optional(),
  deploymentStrategy: z.enum(['eventbridge', 'label', 'deployment']).optional(),
  deploymentMessage: z.string().optional(),
  deploymentApprovedAt: z.number().optional(),
  deploymentStartedAt: z.number().optional(),
  deploymentCompletedAt: z.number().optional(),
  rollbackStatus: z.enum(['triggered', 'failed', 'not-configured']).optional(),
  checkpoints: z.array(CheckpointRecordSchema).optional(),
  signalsReceived: z.record(z.string(), z.unknown()).optional(),
  repoContext: RepoContextSchema.optional(),
  calibrationApplied: z.number().optional(),
  overrideHistory: z
    .array(
      z.object({
        justification: z.string().optional(),
        overriddenAt: z.number(),
        executionId: z.string(),
      })
    )
    .optional(),
});

// --- Knowledge Base Types ---

export const FileMetricsSchema = z.object({
  repoFullName: z.string(),
  filePath: z.string(),
  churnRate30d: z.number(),
  churnRate90d: z.number(),
  bugFixCommitCount30d: z.number(),
  ownerLogins: z.array(z.string()),
  lastModifiedSha: z.string(),
});

export const AuthorProfileSchema = z.object({
  repoFullName: z.string(),
  authorLogin: z.string(),
  rollbackRate: z.number(),
  mergeCount30d: z.number(),
  avgRiskScore: z.number(),
  frequentFiles: z.array(z.string()),
});

export const ModuleNarrativeSchema = z.object({
  repoFullName: z.string(),
  modulePath: z.string(),
  narrativeText: z.string(),
  generatedAtSha: z.string(),
  version: z.number(),
  embedding: z.array(z.number()).optional(),
});

export const RepoRegistryRecordSchema = z.object({
  repoFullName: z.string(),
  indexingStatus: z.enum(['pending', 'indexing', 'indexed', 'failed']),
  contextVersion: z.number(),
  pendingBatches: z.number(),
  queuedExecutionIds: z.array(z.string()),
  lastError: z.string().optional(),
});

// --- Inferred types ---

export type ValidatedPRExecution = z.infer<typeof PRExecutionSchema>;
export type ValidatedCheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
export type ValidatedFileMetrics = z.infer<typeof FileMetricsSchema>;
export type ValidatedAuthorProfile = z.infer<typeof AuthorProfileSchema>;
export type ValidatedModuleNarrative = z.infer<typeof ModuleNarrativeSchema>;
export type ValidatedRepoRegistryRecord = z.infer<typeof RepoRegistryRecordSchema>;
