import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExecutionCard } from '@/components/ExecutionCard';
import type { Execution } from '@/lib/types';

const mockExecution: Execution = {
  executionId: 'exec-123',
  repoFullName: 'acme/api',
  prNumber: 42,
  headSha: 'abc1234567890',
  status: 'completed',
  riskScore: 35,
  timestamp: Date.now() - 3600_000,
  author: 'alice',
  findings: [
    {
      type: 'security',
      severity: 'critical',
      title: 'SQL injection risk',
      description: 'Unsafe query',
    },
    {
      type: 'architecture',
      severity: 'high',
      title: 'Circular dependency',
      description: 'A depends on B which depends on A',
    },
    {
      type: 'style',
      severity: 'low',
      title: 'Naming convention',
      description: 'Use camelCase',
    },
  ],
};

function renderCard(exec: Execution = mockExecution) {
  return render(
    <MemoryRouter>
      <ExecutionCard execution={exec} />
    </MemoryRouter>
  );
}

describe('ExecutionCard', () => {
  it('renders repo name and PR number', () => {
    renderCard();
    expect(screen.getByText(/acme\/api/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('renders status badge', () => {
    renderCard();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('renders risk score', () => {
    renderCard();
    expect(screen.getByText('35')).toBeInTheDocument();
  });

  it('shows only critical and high findings (max 3)', () => {
    renderCard();
    expect(screen.getByText(/SQL injection risk/)).toBeInTheDocument();
    expect(screen.getByText(/Circular dependency/)).toBeInTheDocument();
    expect(screen.queryByText(/Naming convention/)).not.toBeInTheDocument();
  });

  it('renders author name', () => {
    renderCard();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('renders short SHA', () => {
    renderCard();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });
});
