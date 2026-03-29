export type ExecutionStatus =
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

export type FindingType = 'architecture' | 'security' | 'performance' | 'style';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingLifecycle = 'new' | 'recurring' | 'resolved';

export interface Finding {
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  lifecycle?: FindingLifecycle;
}

export interface Execution {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  author?: string;
  title?: string;
  status: ExecutionStatus;
  riskScore?: number;
  confidenceScore?: number;
  findings?: Finding[];
  timestamp?: number;
  deploymentStatus?: string;
  deploymentEnvironment?: string;
  deploymentCompletedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionDetail extends Execution {
  checkpoints?: Checkpoint[];
  signalsReceived?: Record<string, SignalReceived>;
  repoContext?: RepoContext;
  overrideHistory?: Array<{
    justification?: string;
    overriddenAt: number;
    executionId: string;
  }>;
}

export interface ExecutionListResponse {
  executions: Execution[];
  total?: number;
}

export type CheckpointType = 'analysis' | 'pre-deploy' | 'post-deploy-5' | 'post-deploy-30';

export type CheckpointDecision = 'approved' | 'held' | 'rollback';

export interface Checkpoint {
  type: CheckpointType;
  score: number;
  confidence: number;
  missingSignals: string[];
  decision: CheckpointDecision;
  reason: string;
  evaluatedAt: number;
}

export interface SignalReceived {
  source: string;
  receivedAt: number;
  value?: unknown;
}

export interface RepoContext {
  isSharedDependency: boolean;
  downstreamDependentCount: number;
  blastRadiusMultiplier: number;
  repoRollbackRate30d: number;
  simultaneousDeploysInProgress: string[];
}

export interface CheckpointResponse {
  checkpoints: Checkpoint[];
  signalsReceived: Record<string, SignalReceived>;
  repoContext: RepoContext | null;
}

export interface BoardCard {
  executionId: string;
  repoFullName: string;
  prNumber: number;
  author?: string;
  riskScore?: number;
  confidenceScore?: number;
  timestamp?: number;
}

export interface BoardResponse {
  board: Record<string, BoardCard[]>;
}

export interface CalibrationRecord {
  repoFullName: string;
  totalDeployments: number;
  successCount: number;
  calibrationFactor: number;
  observationsCount: number;
  falsePositiveCount?: number;
  falseNegativeCount?: number;
  signalWeights?: Record<string, number>;
  outcomeLog?: OutcomeLogEntry[];
}

export interface OutcomeLogEntry {
  signalsPresent: string[];
  rollback: boolean;
  analysisDecision: 'approved' | 'held';
  timestamp: number;
}

export interface CalibrationListResponse {
  repos: CalibrationRecord[];
}

export type CalibrationDetail = CalibrationRecord;

export interface StatsResponse {
  trends: {
    riskScores: Array<{
      prNumber: number;
      riskScore: number;
      timestamp: number;
    }>;
  };
  summary: {
    total: number;
    avgRisk: number;
    successRate: number;
  };
}

export interface AnalyticsSummary {
  totalPRs: number;
  avgRiskScore: number;
  approvalRate: number;
  rollbackRate: number;
  avgAnalysisTime: number;
  totalFindings: number;
  findingsByType: Record<FindingType, number>;
  findingsBySeverity: Record<FindingSeverity, number>;
}

export interface TrendBucket {
  date: string;
  prCount: number;
  avgRisk: number;
  rollbackCount: number;
}

export interface AuthorStats {
  author: string;
  prCount: number;
  avgRisk: number;
  rollbackRate: number;
  trend: 'improving' | 'stable' | 'declining';
}

export interface RepoStats {
  repoFullName: string;
  prCount: number;
  avgRisk: number;
  rollbackRate: number;
  calibrationFactor: number;
}

export interface CostData {
  totalSpendMTD: number;
  totalTokens: number;
  avgCostPerPR: number;
  projectedMonthly: number;
  dailySpend: Array<{ date: string; cost: number; tokens: number }>;
  byRepo: Array<{
    repoFullName: string;
    cost: number;
    prCount: number;
    budget?: number;
  }>;
  byAgent: Array<{ agent: string; cost: number; tokens: number }>;
  byModel: Array<{ model: string; cost: number; tokens: number; calls: number }>;
}

export interface BudgetStatus {
  repos: Array<{
    repoFullName: string;
    budget: number;
    spent: number;
    percentUsed: number;
  }>;
}

export type NotificationChannelType = 'slack' | 'discord' | 'teams' | 'webhook';

export type NotificationEventType =
  | 'analysis_complete'
  | 'deployment_approved'
  | 'rollback_triggered'
  | 'high_risk_detected'
  | 'budget_exceeded';

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  url: string;
  repoFilter?: string;
  events: NotificationEventType[];
  minRiskScore?: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
