import { screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { CostsPage } from '@/pages/CostsPage';
import type { CostData, BudgetStatus } from '@/lib/types';

const mockCosts: CostData = {
  totalSpendMTD: 48.75,
  totalTokens: 2_500_000,
  avgCostPerPR: 0.406,
  projectedMonthly: 95.0,
  dailySpend: [
    { date: '2024-05-01', cost: 5.5, tokens: 300_000 },
    { date: '2024-05-02', cost: 7.2, tokens: 400_000 },
  ],
  byRepo: [
    { repoFullName: 'acme/api', cost: 25.0, prCount: 60, budget: 50 },
    { repoFullName: 'acme/web', cost: 23.75, prCount: 40 },
  ],
  byAgent: [
    { agent: 'security', cost: 15.0, tokens: 800_000 },
    { agent: 'architecture', cost: 12.5, tokens: 700_000 },
  ],
  byModel: [
    { model: 'claude-sonnet-4-6', cost: 30.0, tokens: 1_500_000, calls: 120 },
    { model: 'claude-haiku', cost: 18.75, tokens: 1_000_000, calls: 200 },
  ],
};

const mockBudgetStatus: BudgetStatus = {
  repos: [{ repoFullName: 'acme/api', budget: 50, spent: 25, percentUsed: 50 }],
};

function setupFetch(costsData: CostData | null = mockCosts) {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/analytics/costs/budget-status')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockBudgetStatus),
      });
    }
    if (url.includes('/analytics/costs')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(costsData),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('CostsPage', () => {
  it('shows loading skeletons initially', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CostsPage />);
    expect(screen.queryByText('Spend MTD')).not.toBeInTheDocument();
  });

  it('renders MTD spend stat card', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Spend MTD')).toBeInTheDocument();
    expect(screen.getByText('$48.75')).toBeInTheDocument();
  });

  it('renders Tokens Used stat card', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Tokens Used')).toBeInTheDocument();
    expect(screen.getByText('2.5M')).toBeInTheDocument();
  });

  it('renders Avg Cost/PR stat card', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Avg Cost/PR')).toBeInTheDocument();
    expect(screen.getByText('$0.406')).toBeInTheDocument();
  });

  it('renders Projected Monthly stat card', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Projected Monthly')).toBeInTheDocument();
    expect(screen.getByText('$95.00')).toBeInTheDocument();
  });

  it('renders Daily Spend chart section', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Daily Spend')).toBeInTheDocument();
  });

  it('renders Cost by Repo section with repo names', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Cost by Repo')).toBeInTheDocument();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('acme/web')).toBeInTheDocument();
  });

  it('renders Cost by Agent chart section', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Cost by Agent')).toBeInTheDocument();
  });

  it('renders Cost by Model table with model names', async () => {
    renderWithProviders(<CostsPage />);
    expect(await screen.findByText('Cost by Model')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('claude-haiku')).toBeInTheDocument();
  });

  it('renders model table with cost and call count', async () => {
    renderWithProviders(<CostsPage />);
    await screen.findByText('Cost by Model');
    expect(screen.getByText('120')).toBeInTheDocument(); // calls
    expect(screen.getByText('200')).toBeInTheDocument(); // calls
  });

  it('shows "No cost data available" when costs are null', async () => {
    // Return null/undefined from the costs endpoint
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/analytics/costs/budget-status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockBudgetStatus),
        });
      }
      // costs returns a falsy value — simulate no data via a failed query
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
      });
    });

    renderWithProviders(<CostsPage />);
    expect(await screen.findByText(/No cost data available/i)).toBeInTheDocument();
  });
});
