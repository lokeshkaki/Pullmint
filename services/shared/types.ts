/**
 * Common types used across Pullmint services
 */

export interface PREvent {
  prNumber: number;
  repoFullName: string;
  headSha: string;
  baseSha: string;
  author: string;
  title: string;
  orgId: string;
}

export interface PRExecution {
  executionId: string;
  repoFullName: string;
  repoPrKey?: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  orgId?: string;
  title?: string;
  author?: string;
  status:
    | 'pending'
    | 'analyzing'
    | 'completed'
    | 'failed'
    | 'deploying'
    | 'deployed'
    | 'deployment-blocked'
    | 'monitoring'
    | 'confirmed'
    | 'rolled-back';
  timestamp?: number;
  entityType?: 'execution';
  findings?: Finding[];
  riskScore?: number;
  confidenceScore?: number;
  error?: string;
  updatedAt?: number;
  deploymentStatus?: 'deploying' | 'deployed' | 'failed';
  deploymentEnvironment?: string;
  deploymentStrategy?: 'eventbridge' | 'label' | 'deployment';
  deploymentMessage?: string;
  deploymentApprovedAt?: number;
  deploymentStartedAt?: number;
  deploymentCompletedAt?: number;
  rollbackStatus?: 'triggered' | 'failed' | 'not-configured';
  checkpoints?: CheckpointRecord[];
  signalsReceived?: Record<string, unknown>;
  repoContext?: RepoContext;
  calibrationApplied?: number;
  overrideHistory?: Array<{ justification?: string; overriddenAt: number; executionId: string }>;
}

export interface Finding {
  type: string; // built-in: 'architecture' | 'security' | 'performance' | 'style'; custom: any kebab-case string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  fingerprint?: string;
  lifecycle?: 'new' | 'persisted' | 'resolved';
}

export interface FindingLifecycleResult {
  findings: Finding[];
  resolved: Finding[];
  stats: {
    new: number;
    persisted: number;
    resolved: number;
  };
}

export interface AnalysisResult {
  executionId: string;
  agentType: string; // built-in: 'architecture' | 'security' | 'performance' | 'style'; custom: any kebab-case string
  findings: Finding[];
  riskScore: number;
  testsPassed?: boolean;
  s3Key?: string;
  findingsCount?: number;
  contextQuality?: 'full' | 'partial' | 'none';
  metadata: {
    processingTime: number;
    tokensUsed: number;
    cached: boolean;
  };
}

export interface AgentResultMeta {
  findingsCount: number;
  riskScore: number;
  model: string;
  tokens: number;
  latencyMs: number;
  status: 'completed' | 'failed';
}

export interface DeploymentApprovedEvent extends PREvent {
  executionId: string;
  riskScore: number;
  deploymentEnvironment: string;
  deploymentStrategy: 'eventbridge' | 'label' | 'deployment';
}

export interface DeploymentStatusEvent extends PREvent {
  executionId: string;
  deploymentEnvironment: string;
  deploymentStatus: 'deploying' | 'deployed' | 'failed';
  deploymentStrategy: 'eventbridge' | 'label' | 'deployment';
  message?: string;
}

export type SignalType =
  | 'production.error_rate'
  | 'production.latency'
  | 'deployment.status'
  | 'ci.coverage'
  | 'ci.result'
  | 'time_of_day'
  | 'author_history'
  | 'simultaneous_deploy';

export interface Signal {
  signalType: SignalType;
  value: number | boolean;
  source: string;
  timestamp: number;
}

export interface RepoContext {
  isSharedDependency: boolean;
  downstreamDependentCount: number;
  blastRadiusMultiplier: number;
  repoRollbackRate30d: number;
  simultaneousDeploysInProgress: string[];
}

export interface CheckpointRecord {
  type: 'analysis' | 'pre-deploy' | 'post-deploy-5' | 'post-deploy-30';
  score: number;
  confidence: number;
  missingSignals: string[];
  signals: Signal[];
  decision: 'approved' | 'held' | 'rollback';
  reason: string;
  confirmedWithLowConfidence?: boolean;
  evaluatedAt: number;
}

export interface RiskEvaluationInput {
  llmBaseScore: number;
  signals: Signal[];
  calibrationFactor: number;
  blastRadiusMultiplier: number;
}

export interface RiskEvaluation {
  score: number;
  confidence: number;
  missingSignals: string[];
  reason: string;
}

export interface DeploymentRollbackEvent {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  reason: string;
  triggeredAt: number;
  checkpointType: 'post-deploy-5' | 'post-deploy-30';
  riskScoreAtTrigger: number;
}

export interface ExecutionConfirmedEvent {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  confirmedWithLowConfidence: boolean;
  finalRiskScore: number;
  confirmedAt: number;
}

export interface ExecutionRolledBackEvent {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  rollbackSource: 'monitor' | 'manual';
  rolledBackAt: number;
}

export interface GitHubPRPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    merged?: boolean;
    merge_commit_sha?: string;
    user: {
      login: string;
    };
    head: {
      sha: string;
    };
    base: {
      sha: string;
    };
  };
  repository: {
    full_name: string;
    owner: {
      id: number;
      login: string;
    };
  };
}

// --- Persistent Knowledge Base ---

export interface FileMetrics {
  repoFullName: string;
  filePath: string;
  churnRate30d: number;
  churnRate90d: number;
  bugFixCommitCount30d: number;
  ownerLogins: string[];
  lastModifiedSha: string;
}

export interface AuthorProfile {
  repoFullName: string;
  authorLogin: string;
  rollbackRate: number;
  mergeCount30d: number;
  avgRiskScore: number;
  frequentFiles: string[];
}

export interface ModuleNarrative {
  repoFullName: string;
  modulePath: string;
  narrativeText: string;
  generatedAtSha: string;
  version: number;
  embedding?: number[];
}

export interface RepoRegistryRecord {
  repoFullName: string;
  indexingStatus: 'pending' | 'indexing' | 'indexed' | 'failed';
  contextVersion: number;
  pendingBatches: number;
  queuedExecutionIds: string[];
  lastError?: string;
}

export interface PRMergedEvent {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  author: string;
  mergedAt: number;
  executionId?: string;
}

export interface ContextPackage {
  fileMetrics: FileMetrics[];
  authorProfile: AuthorProfile | null;
  moduleNarratives: ModuleNarrative[];
  staticFindings: string[];
  prDescription: string;
  contextQuality: 'full' | 'partial' | 'none';
}

export interface GitHubDeploymentStatusPayload {
  deployment: {
    id: number;
    environment: string;
    sha: string;
    payload?: {
      executionId?: string;
      prNumber?: number;
      repoFullName?: string;
      deploymentStrategy?: 'eventbridge' | 'label' | 'deployment';
      baseSha?: string;
      author?: string;
      title?: string;
      orgId?: string;
    };
  };
  deployment_status: {
    state: 'queued' | 'in_progress' | 'success' | 'failure' | 'inactive' | 'error';
    description?: string;
  };
  repository: {
    full_name: string;
    owner: {
      id: number;
      login: string;
    };
  };
}

// --- Signal Weight Learning ---

export type SignalWeights = Record<string, number>;

export interface OutcomeLogEntry {
  signalsPresent: string[];
  rollback: boolean;
  analysisDecision: 'approved' | 'held';
  timestamp: number;
}
