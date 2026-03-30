import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import type { AnalyticsSummary, TrendBucket, AuthorStats, RepoStats } from '@/lib/types';

const mockSummary: AnalyticsSummary = {
  totalPRs: 120,
  avgRiskScore: 38.5,
  approvalRate: 0.82,
  rollbackRate: 0.04,
  avgAnalysisTime: 45,
  totalFindings: 300,
  findingsByType: { architecture: 80, security: 70, performance: 90, style: 60 },
  findingsBySeverity: { critical: 10, high: 30, medium: 100, low: 120, info: 40 },
};

const mockTrends: TrendBucket[] = [
  { date: '2024-05-01', prCount: 10, avgRisk: 35, rollbackCount: 1 },
  { date: '2024-05-02', prCount: 12, avgRisk: 42, rollbackCount: 0 },
];

const mockAuthors: AuthorStats[] = [
  { author: 'alice', prCount: 30, avgRisk: 25.0, rollbackRate: 0.01, trend: 'improving' },
  { author: 'bob', prCount: 20, avgRisk: 60.0, rollbackRate: 0.1, trend: 'declining' },
  { author: 'carol', prCount: 15, avgRisk: 40.0, rollbackRate: 0.05, trend: 'stable' },
];

const mockRepos: RepoStats[] = [
  {
    repoFullName: 'acme/api',
    prCount: 50,
    avgRisk: 35.0,
    rollbackRate: 0.02,
    calibrationFactor: 1.0,
  },
  {
    repoFullName: 'acme/web',
    prCount: 40,
    avgRisk: 42.0,
    rollbackRate: 0.05,
    calibrationFactor: 1.1,
  },
];

function setupFetch() {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/analytics/summary')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockSummary) });
    }
    if (url.includes('/analytics/trends')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ trends: mockTrends }),
      });
    }
    if (url.includes('/analytics/authors')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ authors: mockAuthors }),
      });
    }
    if (url.includes('/analytics/repos')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ repos: mockRepos }),
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

describe('AnalyticsPage', () => {
  it('renders date filter inputs', () => {
    renderWithProviders(<AnalyticsPage />);
    expect(screen.getByText('From:')).toBeInTheDocument();
    expect(screen.getByText('To:')).toBeInTheDocument();
  });

  it('shows loading skeleton before data arrives', () => {
    // Make fetch never resolve
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<AnalyticsPage />);
    // The component renders skeleton divs; check that stat cards are not yet shown
    expect(screen.queryByText('Total PRs')).not.toBeInTheDocument();
  });

  it('renders summary statistics after data loads', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('Total PRs')).toBeInTheDocument();
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getAllByText('Avg Risk').length).toBeGreaterThan(0);
    expect(screen.getByText('38.5')).toBeInTheDocument();
    expect(screen.getByText('Approval Rate')).toBeInTheDocument();
    expect(screen.getByText('82.0%')).toBeInTheDocument();
    expect(screen.getAllByText('Rollback Rate').length).toBeGreaterThan(0);
    expect(screen.getByText('4.0%')).toBeInTheDocument();
  });

  it('renders Risk Trend chart container', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('Risk Trend')).toBeInTheDocument();
  });

  it('renders Findings by Type chart container', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('Findings by Type')).toBeInTheDocument();
  });

  it('renders author leaderboard with author names', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(await screen.findByText('carol')).toBeInTheDocument();
  });

  it('renders author table columns', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('Author')).toBeInTheDocument();
    expect(screen.getAllByText('PRs').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avg Risk').length).toBeGreaterThan(0);
  });

  it('renders repo comparison table with repo names', async () => {
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByText('acme/api')).toBeInTheDocument();
    expect(await screen.findByText('acme/web')).toBeInTheDocument();
  });

  it('handles empty authors gracefully (no author table rendered)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/analytics/summary')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockSummary),
        });
      }
      if (url.includes('/analytics/authors')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ authors: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ trends: [], repos: [] }),
      });
    });
    renderWithProviders(<AnalyticsPage />);
    // Page still renders without crashing
    expect(await screen.findByText('Total PRs')).toBeInTheDocument();
    expect(screen.queryByText('Author Leaderboard')).not.toBeInTheDocument();
  });

  it('allows updating the date filter inputs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);
    const inputs = document.querySelectorAll('input[type="date"]');
    await user.type(inputs[0] as HTMLElement, '2024-05-01');
    expect((inputs[0] as HTMLInputElement).value).toBe('2024-05-01');
  });
});
