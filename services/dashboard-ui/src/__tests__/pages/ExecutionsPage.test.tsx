import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import type { ExecutionListResponse } from '@/lib/types';
import { ExecutionsPage } from '@/pages/ExecutionsPage';

const mockResponse: ExecutionListResponse = {
  executions: [
    {
      executionId: 'exec-1',
      repoFullName: 'acme/api',
      prNumber: 10,
      headSha: 'aaa1111',
      status: 'completed',
      riskScore: 25,
      timestamp: Date.now(),
      author: 'alice',
      findings: [],
    },
    {
      executionId: 'exec-2',
      repoFullName: 'acme/web',
      prNumber: 20,
      headSha: 'bbb2222',
      status: 'analyzing',
      timestamp: Date.now(),
      author: 'bob',
      findings: [],
    },
  ],
};

function renderPage() {
  localStorage.setItem('pullmint_token', 'test-token');

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockResponse),
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <ExecutionsPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe('ExecutionsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders filter inputs', () => {
    renderPage();
    expect(screen.getByPlaceholderText('Search repo or PR #...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('owner/repo')).toBeInTheDocument();
    expect(screen.getByText('Apply')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('renders execution cards after data loads', async () => {
    renderPage();
    expect(await screen.findByText(/acme\/api/)).toBeInTheDocument();
    expect(await screen.findByText(/acme\/web/)).toBeInTheDocument();
  });

  it('renders stat cards', async () => {
    renderPage();
    expect(await screen.findByText('Total PRs')).toBeInTheDocument();
    expect(await screen.findByText('Avg Risk Score')).toBeInTheDocument();
  });
});
