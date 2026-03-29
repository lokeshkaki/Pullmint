import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts unauthenticated when no token stored', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  it('logs in and stores token', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    act(() => {
      result.current.login('my-test-token');
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe('my-test-token');
    expect(localStorage.getItem('pullmint_token')).toBe('my-test-token');
  });

  it('logs out and clears token', () => {
    localStorage.setItem('pullmint_token', 'existing-token');

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      result.current.logout();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(localStorage.getItem('pullmint_token')).toBeNull();
  });

  it('restores token from localStorage on mount', () => {
    localStorage.setItem('pullmint_token', 'stored-token');

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe('stored-token');
  });
});
