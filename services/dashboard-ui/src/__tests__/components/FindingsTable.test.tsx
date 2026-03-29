import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindingsTable } from '@/components/FindingsTable';
import type { Finding } from '@/lib/types';

const findings: Finding[] = [
  {
    type: 'security',
    severity: 'critical',
    title: 'Hardcoded secret',
    description: 'API key exposed in source',
    file: 'src/config.ts',
    line: 42,
    suggestion: 'Use environment variables',
  },
  {
    type: 'architecture',
    severity: 'medium',
    title: 'Large file',
    description: 'File exceeds 500 lines',
    file: 'src/handler.ts',
  },
  {
    type: 'performance',
    severity: 'low',
    title: 'N+1 query',
    description: 'Use batch fetch',
  },
];

describe('FindingsTable', () => {
  it('renders all findings', () => {
    render(<FindingsTable findings={findings} />);
    expect(screen.getByText('Hardcoded secret')).toBeInTheDocument();
    expect(screen.getByText('Large file')).toBeInTheDocument();
    expect(screen.getByText('N+1 query')).toBeInTheDocument();
  });

  it('shows file and line when available', () => {
    render(<FindingsTable findings={findings} />);
    expect(screen.getByText('src/config.ts:42')).toBeInTheDocument();
  });

  it('expands row on click to show description', async () => {
    const user = userEvent.setup();
    render(<FindingsTable findings={findings} />);

    const row = screen.getByText('Hardcoded secret').closest('tr')!;
    await user.click(row);

    expect(screen.getByText('API key exposed in source')).toBeInTheDocument();
    expect(screen.getByText(/Use environment variables/)).toBeInTheDocument();
  });

  it('filters by severity', async () => {
    const user = userEvent.setup();
    render(<FindingsTable findings={findings} />);

    const severitySelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(severitySelect, 'critical');

    expect(screen.getByText('Hardcoded secret')).toBeInTheDocument();
    expect(screen.queryByText('Large file')).not.toBeInTheDocument();
  });

  it('filters by type', async () => {
    const user = userEvent.setup();
    render(<FindingsTable findings={findings} />);

    const typeSelect = screen.getAllByRole('combobox')[1];
    await user.selectOptions(typeSelect, 'performance');

    expect(screen.getByText('N+1 query')).toBeInTheDocument();
    expect(screen.queryByText('Hardcoded secret')).not.toBeInTheDocument();
  });

  it('shows empty state when no findings match filter', async () => {
    const user = userEvent.setup();
    render(<FindingsTable findings={findings} />);

    const severitySelect = screen.getAllByRole('combobox')[0];
    await user.selectOptions(severitySelect, 'info');

    expect(screen.getByText('No findings match the current filters.')).toBeInTheDocument();
  });
});
