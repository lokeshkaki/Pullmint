import { screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { BoardPage } from '@/pages/BoardPage';
import type { BoardResponse } from '@/lib/types';

const mockBoardResponse: BoardResponse = {
  board: {
    analyzing: [{ executionId: 'exec-1', repoFullName: 'acme/api', prNumber: 1, riskScore: 30 }],
    completed: [
      {
        executionId: 'exec-2',
        repoFullName: 'acme/web',
        prNumber: 2,
        riskScore: 70,
        author: 'alice',
      },
    ],
    deploying: [{ executionId: 'exec-3', repoFullName: 'acme/infra', prNumber: 3, riskScore: 50 }],
    monitoring: [],
    confirmed: [],
    'rolled-back': [{ executionId: 'exec-4', repoFullName: 'acme/db', prNumber: 4, riskScore: 85 }],
  },
};

function setupFetch(response: BoardResponse = mockBoardResponse) {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(response),
  });
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('BoardPage', () => {
  it('shows loading skeletons initially', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<BoardPage />);
    const skeletons = document.querySelectorAll('[class*="h-64"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders all kanban column headers after data loads', async () => {
    renderWithProviders(<BoardPage />);
    expect(await screen.findByText('Analyzing')).toBeInTheDocument();
    expect(screen.getByText('Pre-Deploy Hold')).toBeInTheDocument();
    expect(screen.getByText('Deploying')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Rolled Back')).toBeInTheDocument();
  });

  it('displays summary counts (active, held, rollbacks)', async () => {
    renderWithProviders(<BoardPage />);
    await screen.findByText('Analyzing'); // wait for load
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/held/i)).toBeInTheDocument();
    expect(screen.getByText(/rollbacks/i)).toBeInTheDocument();
  });

  it('shows error card when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    renderWithProviders(<BoardPage />);
    expect(await screen.findByText(/Failed to load the risk board/i)).toBeInTheDocument();
  });

  it('renders empty state text in columns with no cards', async () => {
    renderWithProviders(<BoardPage />);
    await screen.findByText('Analyzing'); // wait for load
    // "Monitoring" column has 0 cards
    const noDeployments = screen.getAllByText('No deployments');
    expect(noDeployments.length).toBeGreaterThan(0);
  });

  it('renders cards with risk scores from analyzed executions', async () => {
    renderWithProviders(<BoardPage />);
    // Risk scores appear on KanbanCard components
    expect(await screen.findByText('30')).toBeInTheDocument();
    expect(await screen.findByText('70')).toBeInTheDocument();
  });
});
