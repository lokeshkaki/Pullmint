import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderWithProviders } from '../../test-utils';
import { AppLayout } from '@/components/layout/AppLayout';

function renderLayout(route = '/') {
  return renderWithProviders(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div>Executions Content</div>} />
        <Route path="/board" element={<div>Board Content</div>} />
        <Route path="/analytics" element={<div>Analytics Content</div>} />
        <Route path="/costs" element={<div>Costs Content</div>} />
        <Route path="/calibration" element={<div>Calibration Content</div>} />
        <Route path="/notifications" element={<div>Notifications Content</div>} />
      </Route>
    </Routes>,
    { route }
  );
}

beforeEach(() => {
  localStorage.setItem('pullmint_token', 'test-token');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('AppLayout', () => {
  it('renders the Pullmint logo/brand name in sidebar', () => {
    renderLayout('/');
    expect(screen.getByText('Pullmint')).toBeInTheDocument();
  });

  it('renders all navigation links in the sidebar', () => {
    renderLayout('/');
    expect(screen.getByRole('link', { name: /Executions/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Risk Board/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Analytics/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Costs/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Calibration/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Notifications/i })).toBeInTheDocument();
  });

  it('renders header breadcrumb with Dashboard prefix', () => {
    renderLayout('/');
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders the "Executions" label in header for root route', () => {
    renderLayout('/');
    // Header renders current page label
    const executions = screen.getAllByText('Executions');
    expect(executions.length).toBeGreaterThan(0);
  });

  it('renders the "Analytics" label in header for /analytics route', () => {
    renderLayout('/analytics');
    const analytics = screen.getAllByText('Analytics');
    expect(analytics.length).toBeGreaterThan(0);
  });

  it('renders the "Risk Board" label in header for /board route', () => {
    renderLayout('/board');
    const board = screen.getAllByText('Risk Board');
    expect(board.length).toBeGreaterThan(0);
  });

  it('renders children in the main content area', () => {
    renderLayout('/');
    expect(screen.getByText('Executions Content')).toBeInTheDocument();
  });

  it('renders children for nested route', () => {
    renderLayout('/board');
    expect(screen.getByText('Board Content')).toBeInTheDocument();
  });

  it('renders SSE connection indicator', () => {
    renderLayout('/');
    // The header shows Live or Disconnected based on SSE connected state
    // Since SSE is mocked (EventSource mock in setup.ts), it starts disconnected
    expect(screen.getByText(/Live|Disconnected/i)).toBeInTheDocument();
  });

  it('renders Disconnect button in sidebar', () => {
    renderLayout('/');
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();
  });
});
