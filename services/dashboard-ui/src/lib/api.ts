import type {
  AnalyticsSummary,
  AuthorStats,
  BoardResponse,
  BudgetStatus,
  CalibrationDetail,
  CalibrationListResponse,
  CheckpointResponse,
  CostData,
  Execution,
  ExecutionDetail,
  ExecutionListResponse,
  NotificationChannel,
  RepoStats,
  StatsResponse,
  TrendBucket,
} from './types';

const API_BASE = '/dashboard';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getToken(): string | null {
  return localStorage.getItem('pullmint_token');
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const url = path.startsWith('/') ? path : `${API_BASE}/${path}`;
  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    throw new ApiError(
      `API request failed: ${response.status} ${response.statusText}`,
      response.status,
      body
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function fetchExecutions(params: URLSearchParams): Promise<ExecutionListResponse> {
  return apiFetch(`${API_BASE}/executions?${params.toString()}`);
}

export function fetchExecution(executionId: string): Promise<ExecutionDetail> {
  return apiFetch(`${API_BASE}/executions/${executionId}`);
}

export function fetchCheckpoints(executionId: string): Promise<CheckpointResponse> {
  return apiFetch(`${API_BASE}/executions/${executionId}/checkpoints`);
}

export function reEvaluate(executionId: string, justification: string): Promise<void> {
  return apiFetch(`${API_BASE}/executions/${executionId}/re-evaluate`, {
    method: 'POST',
    body: JSON.stringify({ justification }),
  });
}

export function rerunAnalysis(executionId: string): Promise<void> {
  return apiFetch(`${API_BASE}/executions/${executionId}/rerun`, {
    method: 'POST',
  });
}

export function fetchBoard(): Promise<BoardResponse> {
  return apiFetch(`${API_BASE}/board`);
}

export function fetchStats(owner: string, repo: string): Promise<StatsResponse> {
  return apiFetch(`${API_BASE}/stats/${owner}/${repo}`);
}

export function fetchCalibration(): Promise<CalibrationListResponse> {
  return apiFetch(`${API_BASE}/calibration`);
}

export function fetchCalibrationDetail(owner: string, repo: string): Promise<CalibrationDetail> {
  return apiFetch(`${API_BASE}/calibration/${owner}/${repo}`);
}

export function triggerReindex(owner: string, repo: string): Promise<void> {
  return apiFetch(`${API_BASE}/repos/${owner}/${repo}/reindex`, {
    method: 'POST',
  });
}

export function fetchPRExecutions(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ executions: Execution[] }> {
  return apiFetch(`${API_BASE}/repos/${owner}/${repo}/prs/${prNumber}`);
}

export function fetchAnalyticsSummary(params?: URLSearchParams): Promise<AnalyticsSummary> {
  const qs = params ? `?${params.toString()}` : '';
  return apiFetch(`${API_BASE}/analytics/summary${qs}`);
}

export function fetchAnalyticsTrends(params?: URLSearchParams): Promise<{ trends: TrendBucket[] }> {
  const qs = params ? `?${params.toString()}` : '';
  return apiFetch(`${API_BASE}/analytics/trends${qs}`);
}

export function fetchAnalyticsAuthors(
  params?: URLSearchParams
): Promise<{ authors: AuthorStats[] }> {
  const qs = params ? `?${params.toString()}` : '';
  return apiFetch(`${API_BASE}/analytics/authors${qs}`);
}

export function fetchAnalyticsRepos(params?: URLSearchParams): Promise<{ repos: RepoStats[] }> {
  const qs = params ? `?${params.toString()}` : '';
  return apiFetch(`${API_BASE}/analytics/repos${qs}`);
}

export function fetchCosts(params?: URLSearchParams): Promise<CostData> {
  const qs = params ? `?${params.toString()}` : '';
  return apiFetch(`${API_BASE}/analytics/costs${qs}`);
}

export function fetchBudgetStatus(): Promise<BudgetStatus> {
  return apiFetch(`${API_BASE}/analytics/costs/budget-status`);
}

export function fetchNotifications(): Promise<{
  channels: NotificationChannel[];
}> {
  return apiFetch(`${API_BASE}/notifications`);
}

export function createNotification(
  channel: Omit<NotificationChannel, 'id' | 'createdAt' | 'updatedAt'>
): Promise<NotificationChannel> {
  return apiFetch(`${API_BASE}/notifications`, {
    method: 'POST',
    body: JSON.stringify(channel),
  });
}

export function updateNotification(
  id: string,
  channel: Partial<NotificationChannel>
): Promise<NotificationChannel> {
  return apiFetch(`${API_BASE}/notifications/${id}`, {
    method: 'PUT',
    body: JSON.stringify(channel),
  });
}

export function deleteNotification(id: string): Promise<void> {
  return apiFetch(`${API_BASE}/notifications/${id}`, {
    method: 'DELETE',
  });
}
