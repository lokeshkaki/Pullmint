import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { useSSE } from '@/lib/sse';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  close() {
    this.readyState = 2;
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError() {
    this.onerror?.();
  }
}

const originalEventSource = globalThis.EventSource;

beforeAll(() => {
  // @ts-expect-error test mock type mismatch
  globalThis.EventSource = MockEventSource;
});

afterAll(() => {
  globalThis.EventSource = originalEventSource;
});

beforeEach(() => {
  MockEventSource.instances = [];
  localStorage.setItem('pullmint_token', 'test-token');
});

afterEach(() => {
  localStorage.clear();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('useSSE', () => {
  it('creates an EventSource with token', () => {
    renderHook(() => useSSE(), { wrapper: createWrapper() });
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toContain('token=test-token');
  });

  it('includes repo filter in URL when provided', () => {
    renderHook(() => useSSE('acme/api'), { wrapper: createWrapper() });
    expect(MockEventSource.instances[0].url).toContain('repo=acme%2Fapi');
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE(), {
      wrapper: createWrapper(),
    });
    const eventSource = MockEventSource.instances[0];
    unmount();
    expect(eventSource.readyState).toBe(2);
  });

  it('sets connected to true on open', async () => {
    const { result } = renderHook(() => useSSE(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current.connected).toBe(true);
  });
});
