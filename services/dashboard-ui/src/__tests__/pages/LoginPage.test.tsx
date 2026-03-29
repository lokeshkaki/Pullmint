import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { LoginPage } from '@/pages/LoginPage';

function renderLogin() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  it('renders the login form', () => {
    renderLogin();
    expect(screen.getByText('Pullmint Dashboard')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Dashboard token')).toBeInTheDocument();
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('shows error for empty token', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByText('Connect'));
    expect(screen.getByText('Token is required')).toBeInTheDocument();
  });

  it('validates token against API', async () => {
    const user = userEvent.setup();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    renderLogin();

    const input = screen.getByPlaceholderText('Dashboard token');
    await user.type(input, 'bad-token');
    await user.click(screen.getByText('Connect'));

    expect(
      await screen.findByText('Invalid token. Please check and try again.')
    ).toBeInTheDocument();
  });

  it('stores token and navigates on success', async () => {
    const user = userEvent.setup();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ executions: [] }),
    });

    renderLogin();

    const input = screen.getByPlaceholderText('Dashboard token');
    await user.type(input, 'valid-token');
    await user.click(screen.getByText('Connect'));

    expect(localStorage.getItem('pullmint_token')).toBe('valid-token');
  });
});
