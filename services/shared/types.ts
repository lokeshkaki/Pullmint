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
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'deploying' | 'deployed';
  timestamp?: number;
  entityType?: 'execution';
  findings?: Finding[];
  riskScore?: number;
  error?: string;
  updatedAt?: number;
  deploymentStatus?: 'deploying' | 'deployed' | 'failed';
  deploymentEnvironment?: string;
  deploymentStrategy?: 'eventbridge' | 'label' | 'deployment';
  deploymentMessage?: string;
  deploymentApprovedAt?: number;
  deploymentStartedAt?: number;
  deploymentCompletedAt?: number;
}

export interface Finding {
  type: 'architecture' | 'security' | 'performance' | 'style';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface AnalysisResult {
  executionId: string;
  agentType: 'architecture' | 'security' | 'performance';
  findings: Finding[];
  riskScore: number;
  testsPassed?: boolean;
  metadata: {
    processingTime: number;
    tokensUsed: number;
    cached: boolean;
  };
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

export interface GitHubPRPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
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
