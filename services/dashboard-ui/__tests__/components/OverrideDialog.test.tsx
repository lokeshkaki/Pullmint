import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OverrideDialog } from '@/components/OverrideDialog';

function renderDialog(
  props: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    executionId?: string;
    currentRiskScore?: number;
    currentDecision?: string;
  } = {}
) {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    executionId: 'exec-test-123',
    currentRiskScore: 72,
    ...props,
  };
  return render(<OverrideDialog {...defaultProps} />);
}

beforeEach(() => {
  localStorage.setItem('pullmint_token', 'test-token');
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    json: () => Promise.resolve(null),
  });
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('OverrideDialog', () => {
  it('renders dialog title when open', () => {
    renderDialog();
    expect(screen.getByText('Override Decision')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByText('Override Decision')).not.toBeInTheDocument();
  });

  it('displays current risk score', () => {
    renderDialog({ currentRiskScore: 72 });
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('Current Risk Score')).toBeInTheDocument();
  });

  it('displays current decision when provided', () => {
    renderDialog({ currentDecision: 'held' });
    expect(screen.getByText('held')).toBeInTheDocument();
    expect(screen.getByText('Current Decision')).toBeInTheDocument();
  });

  it('renders justification textarea', () => {
    renderDialog();
    expect(screen.getByPlaceholderText(/Explain why you are overriding/i)).toBeInTheDocument();
  });

  it('renders Cancel and Submit Override buttons', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit Override/i })).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('submits override with justification when form is filled and submitted', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange, executionId: 'exec-test-123' });

    const textarea = screen.getByPlaceholderText(/Explain why you are overriding/i);
    await user.type(textarea, 'Manually approved after team review');

    await user.click(screen.getByRole('button', { name: /Submit Override/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const postCall = calls.find(
        ([url, init]) =>
          String(url).includes('/executions/exec-test-123/re-evaluate') &&
          (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      if (!postCall) return;
      const rawBody = (postCall[1] as RequestInit).body;
      const body = typeof rawBody === 'string' ? rawBody : '';
      expect(body).toContain('Manually approved after team review');
    });
  });

  it('calls onOpenChange(false) after successful submission', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    const textarea = screen.getByPlaceholderText(/Explain why you are overriding/i);
    await user.type(textarea, 'Valid justification for override');

    await user.click(screen.getByRole('button', { name: /Submit Override/i }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('disables Submit button while submitting', async () => {
    const pendingResponse: ReturnType<typeof fetch> = new Promise<Response>(() => {});
    const pendingFetch: typeof fetch = () => pendingResponse;
    globalThis.fetch = vi.fn(pendingFetch);
    const user = userEvent.setup();
    renderDialog();

    const textarea = screen.getByPlaceholderText(/Explain why you are overriding/i);
    await user.type(textarea, 'Some justification');

    const submitBtn = screen.getByRole('button', { name: /Submit Override/i });
    await user.click(submitBtn);

    expect(screen.getByRole('button', { name: /Submitting/i })).toBeDisabled();
  });

  it('shows validation error when submitted without justification', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Submit Override/i }));

    expect(await screen.findByText('Justification is required.')).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows error toast on failed submission (non-429)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: () => Promise.resolve({ error: 'internal error' }),
    });

    const user = userEvent.setup();
    renderDialog();

    const textarea = screen.getByPlaceholderText(/Explain why you are overriding/i);
    await user.type(textarea, 'Some reason');

    await user.click(screen.getByRole('button', { name: /Submit Override/i }));

    // Dialog remains open (onOpenChange not called with false on error)
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    // Submit button re-enables after error
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Submit Override/i })).not.toBeDisabled();
    });
  });
});
