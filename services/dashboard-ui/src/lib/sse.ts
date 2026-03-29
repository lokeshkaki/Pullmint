import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';

export interface ExecutionUpdateEvent {
  executionId: string;
  status?: string;
  riskScore?: number | null;
  confidenceScore?: number | null;
  findings?: unknown[];
  [key: string]: unknown;
}

interface UseSSEReturn {
  connected: boolean;
  lastEvent: ExecutionUpdateEvent | null;
}

const MAX_RECONNECT_DELAY = 30_000;

export function useSSE(repoFilter?: string): UseSSEReturn {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ExecutionUpdateEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!token) return;
    cleanup();

    const params = new URLSearchParams({ token });
    if (repoFilter) params.set('repo', repoFilter);

    const url = `/dashboard/events?${params.toString()}`;
    const eventSource = new EventSource(url);
    esRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      reconnectDelayRef.current = 1000;
    };

    eventSource.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as ExecutionUpdateEvent;
        setLastEvent(data);
        void queryClient.invalidateQueries({ queryKey: ['executions'] });
        if (typeof data.executionId === 'string') {
          void queryClient.invalidateQueries({
            queryKey: ['execution', data.executionId],
          });
        }
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      } catch {
        // Ignore invalid payloads.
      }
    };

    eventSource.onerror = () => {
      setConnected(false);
      eventSource.close();
      esRef.current = null;

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);

      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [cleanup, queryClient, repoFilter, token]);

  useEffect(() => {
    connect();
    return cleanup;
  }, [cleanup, connect]);

  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        cleanup();
        setConnected(false);
      } else {
        reconnectDelayRef.current = 1000;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [cleanup, connect]);

  return { connected, lastEvent };
}
