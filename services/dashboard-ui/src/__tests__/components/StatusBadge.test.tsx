import { render, screen } from '@testing-library/react';
import { StatusBadge } from '@/components/StatusBadge';
import type { ExecutionStatus } from '@/lib/types';

describe('StatusBadge', () => {
  const statuses: ExecutionStatus[] = [
    'pending',
    'analyzing',
    'completed',
    'failed',
    'deploying',
    'monitoring',
    'confirmed',
    'rolled-back',
  ];

  it.each(statuses)('renders %s status text', (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  it('applies analyzing style for analyzing status', () => {
    render(<StatusBadge status="analyzing" />);
    const badge = screen.getByText('analyzing');
    expect(badge.className).toContain('bg-blue');
  });

  it('applies red style for failed status', () => {
    render(<StatusBadge status="failed" />);
    const badge = screen.getByText('failed');
    expect(badge.className).toContain('bg-red');
  });

  it('applies emerald style for confirmed status', () => {
    render(<StatusBadge status="confirmed" />);
    const badge = screen.getByText('confirmed');
    expect(badge.className).toContain('bg-emerald');
  });
});
