import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { ExecutionDetailPage } from '@/pages/ExecutionDetailPage';
import type { CheckpointResponse, ExecutionDetail } from '@/lib/types';

const mockExecution: ExecutionDetail = {
  executionId: 'exec-abc',
  repoFullName: 'acme/api',
  prNumber: 42,
  headSha: 'deadbeef1234567',
  author: 'alice',
  title: 'Add rate limiting to endpoint',
  status: 'completed',
  riskScore: 62,
  findings: [
    {
      type: 'security',
      severity: 'high',
      title: 'Missing input validation',
      description: 'User input is not sanitized',
      file: 'src/routes/api.ts',
      line: 20,
    },
    {
      type: 'performance',
      severity: 'medium',
      title: 'N+1 query',
      description: 'Loop executes a query per item',
      file: 'src/db/query.ts',
      line: 55,
    },
  ],
  metadata: { repoConfig: {}, incremental: false },
};

const mockCheckpoints: CheckpointResponse = {
  checkpoints: [
    {
      type: 'analysis',
      score: 62,
      confidence: 0.8,
      missingSignals: [],
      decision: 'held',
      reason: 'Risk too high',
      evaluatedAt: Date.now(),
    },
  ],
  signalsReceived: {
    ci_passed: { source: 'github-actions', receivedAt: Date.now(), value: true },
  },
  repoContext: {
    isSharedDependency: true,
    downstreamDependentCount: 3,
    blastRadiusMultiplier: 1.5,
    repoRollbackRate30d: 0.05,
    simultaneousDeploysInProgress: [],
  },
};

function renderDetailPage(executionId = 'exec-abc') {
  return renderWithProviders(
    <Routes>
      <Route path="/execution/:id" element={<ExecutionDetailPage />} />
    </Routes>,
    { route: `/execution/${executionId}` }
  );
}

function setupFetch(
  executionData: ExecutionDetail | null = mockExecution,
  checkpointData: CheckpointResponse | null = mockCheckpoints
) {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/checkpoints')) {
      if (!checkpointData) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Error',
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(checkpointData),
      });
    }
    if (!executionData) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(executionData),
    });
  });
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ExecutionDetailPage', () => {
  it('shows loading skeletons before data arrives', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    // The page shows skeleton while loading
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
  });

  it('shows error state when execution fetch returns 404', async () => {
    setupFetch(null, null);
    renderDetailPage();
    expect(await screen.findByText(/Execution not found/i)).toBeInTheDocument();
  });

  it('renders repo name and PR number', async () => {
    renderDetailPage();
    expect(await screen.findByText(/acme\/api/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('renders PR title', async () => {
    renderDetailPage();
    expect(await screen.findByText('Add rate limiting to endpoint')).toBeInTheDocument();
  });

  it('renders status badge', async () => {
    renderDetailPage();
    expect(await screen.findByText('completed')).toBeInTheDocument();
  });

  it('renders author and shortSHA', async () => {
    renderDetailPage();
    expect(await screen.findByText(/by alice/)).toBeInTheDocument();
    expect(screen.getByText('deadbee')).toBeInTheDocument();
  });

  it('renders risk score and action buttons', async () => {
    renderDetailPage();
    expect(await screen.findByText('62')).toBeInTheDocument();
    expect(await screen.findByText(/Re-run/)).toBeInTheDocument();
    expect(screen.getByText(/Override/)).toBeInTheDocument();
  });

  it('renders checkpoint timeline section', async () => {
    renderDetailPage();
    await screen.findByText(/acme\/api/); // wait for load
    // Checkpoint timeline renders — check for checkpoint type or decision
    expect(screen.getByText(/analysis/i)).toBeInTheDocument();
  });

  it('renders findings tab with finding count', async () => {
    renderDetailPage();
    expect(await screen.findByText(/Findings \(2\)/i)).toBeInTheDocument();
  });

  it('renders findings table with finding titles by default', async () => {
    renderDetailPage();
    expect(await screen.findByText('Missing input validation')).toBeInTheDocument();
    expect(screen.getByText('N+1 query')).toBeInTheDocument();
  });

  it('renders Signals tab', async () => {
    renderDetailPage();
    await screen.findByText(/acme\/api/);
    expect(screen.getByText('Signals')).toBeInTheDocument();
  });

  it('renders Metadata tab with JSON content', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText(/acme\/api/);
    await user.click(screen.getByRole('tab', { name: 'Metadata' }));
    expect(await screen.findByText(/incremental/)).toBeInTheDocument();
  });

  it('clicking Re-run calls rerunAnalysis API', async () => {
    const user = userEvent.setup();
    setupFetch();
    renderDetailPage();
    await screen.findByText(/Re-run/);

    const rerunBtn = screen.getByRole('button', { name: /Re-run/i });
    await user.click(rerunBtn);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        calls.some(
          ([url, init]) =>
            String(url).includes('/rerun') && (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true);
    });
  });

  it('clicking Override opens the override dialog', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText(/Override/);
    const overrideBtn = screen.getByRole('button', { name: /Override/i });
    await user.click(overrideBtn);
    expect(await screen.findByText('Override Decision')).toBeInTheDocument();
  });

  it('renders signals in the Signals tab', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText('Signals');
    await user.click(screen.getByRole('tab', { name: /Signals/i }));
    expect(await screen.findByText('ci_passed')).toBeInTheDocument();
  });

  it('renders repo context in the Signals tab', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByText('Signals');
    await user.click(screen.getByRole('tab', { name: /Signals/i }));
    expect(await screen.findByText('Repo Context')).toBeInTheDocument();
    expect(screen.getByText(/1.50x/)).toBeInTheDocument();
  });
});
