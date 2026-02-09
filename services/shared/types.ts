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
  prNumber: number;
  headSha: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed' | 'deploying' | 'deployed';
  timestamp?: number;
  findings?: Finding[];
  riskScore?: number;
  error?: string;
  updatedAt?: number;
  deploymentStrategy?: 'label' | 'deployment';
  deploymentEnvironment?: string;
  deploymentStatus?: string;
  deploymentId?: number;
  deploymentUrl?: string;
  deploymentUpdatedAt?: number;
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
  metadata: {
    processingTime: number;
    tokensUsed: number;
    cached: boolean;
  };
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
    environment?: string;
    payload?: Record<string, unknown> | string;
  };
  deployment_status: {
    state: string;
    environment_url?: string;
    log_url?: string;
  };
  repository: {
    full_name: string;
    owner: {
      id: number;
      login: string;
    };
  };
}
