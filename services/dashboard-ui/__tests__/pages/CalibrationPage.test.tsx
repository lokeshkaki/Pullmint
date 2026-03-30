import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { CalibrationPage } from '@/pages/CalibrationPage';
import type { CalibrationListResponse } from '@/lib/types';

const mockCalibration: CalibrationListResponse = {
  repos: [
    {
      repoFullName: 'acme/api',
      totalDeployments: 25,
      successCount: 23,
      calibrationFactor: 1.15,
      observationsCount: 15,
      falsePositiveCount: 2,
      falseNegativeCount: 0,
      signalWeights: {
        ci_passed: 1.2,
        test_coverage_drop: 0.8,
        error_rate_spike: 1.5,
      },
      outcomeLog: [
        {
          signalsPresent: ['ci_passed'],
          rollback: false,
          analysisDecision: 'approved',
          timestamp: Date.now() - 86_400_000,
        },
        {
          signalsPresent: ['ci_passed', 'error_rate_spike'],
          rollback: true,
          analysisDecision: 'held',
          timestamp: Date.now() - 2 * 86_400_000,
        },
      ],
    },
    {
      repoFullName: 'acme/web',
      totalDeployments: 8,
      successCount: 8,
      calibrationFactor: 1.0,
      observationsCount: 5, // < 10, should show "Pending"
    },
  ],
};

function setupFetch(response: CalibrationListResponse = mockCalibration) {
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

describe('CalibrationPage', () => {
  it('shows loading skeletons before data arrives', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CalibrationPage />);
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
  });

  it('shows empty state when no calibration data', async () => {
    setupFetch({ repos: [] });
    renderWithProviders(<CalibrationPage />);
    expect(await screen.findByText(/No calibration data yet/i)).toBeInTheDocument();
  });

  it('renders repo names in calibration rows', async () => {
    renderWithProviders(<CalibrationPage />);
    expect(await screen.findByText('acme/api')).toBeInTheDocument();
    expect(screen.getByText('acme/web')).toBeInTheDocument();
  });

  it('renders deployment counts', async () => {
    renderWithProviders(<CalibrationPage />);
    expect(await screen.findByText('25 deployments')).toBeInTheDocument();
    expect(screen.getByText('8 deployments')).toBeInTheDocument();
  });

  it('renders active calibration factor for repos with >= 10 observations', async () => {
    renderWithProviders(<CalibrationPage />);
    expect(await screen.findByText('1.15x')).toBeInTheDocument();
  });

  it('renders "Pending" status for repos with < 10 observations', async () => {
    renderWithProviders(<CalibrationPage />);
    expect(await screen.findByText(/Pending \(5\/10\)/i)).toBeInTheDocument();
  });

  it('expands row to show signal weights on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalibrationPage />);
    await screen.findByText('acme/api');

    const trigger =
      screen.getByText('acme/api').closest('[class*="trigger"], button, [role="button"]') ??
      screen.getByText('acme/api').closest('[data-state]') ??
      screen.getByText('acme/api');
    if (!trigger) throw new Error('Missing collapsible trigger');

    await user.click(trigger);

    // After expanding, signal weights section should appear
    await waitFor(() => {
      expect(screen.getByText('Signal Weights')).toBeInTheDocument();
    });
  });

  it('shows signal weight names after expanding', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalibrationPage />);
    await screen.findByText('acme/api');

    const trigger =
      screen.getByText('acme/api').closest('[data-state]') ?? screen.getByText('acme/api');
    if (!trigger) throw new Error('Missing collapsible trigger');
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByText('ci_passed')).toBeInTheDocument();
    });
  });

  it('shows outcome log after expanding', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalibrationPage />);
    await screen.findByText('acme/api');

    const trigger =
      screen.getByText('acme/api').closest('[data-state]') ?? screen.getByText('acme/api');
    if (!trigger) throw new Error('Missing collapsible trigger');
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByText('Recent Outcomes')).toBeInTheDocument();
    });
    // Most recent outcome shows Rollback
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  it('shows Reindex button after expanding', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalibrationPage />);
    await screen.findByText('acme/api');

    const trigger =
      screen.getByText('acme/api').closest('[data-state]') ?? screen.getByText('acme/api');
    if (!trigger) throw new Error('Missing collapsible trigger');
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reindex/i })).toBeInTheDocument();
    });
  });
});
