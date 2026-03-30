import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiError } from '@/lib/api';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiFetch', () => {
  it('attaches Authorization header when token is in localStorage', async () => {
    localStorage.setItem('pullmint_token', 'my-secret-token');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: 'ok' }),
    });

    await apiFetch('/dashboard/test');

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-secret-token');
  });

  it('omits Authorization header when no token in localStorage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: 'ok' }),
    });

    await apiFetch('/dashboard/test');

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sets Content-Type header when body is a string', async () => {
    localStorage.setItem('pullmint_token', 'test-token');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });

    await apiFetch('/dashboard/test', {
      method: 'POST',
      body: JSON.stringify({ key: 'value' }),
    });

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('parses and returns JSON from a successful response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ executions: [], total: 0 }),
    });

    const result = await apiFetch<{ executions: unknown[]; total: number }>(
      '/dashboard/executions'
    );
    expect(result).toEqual({ executions: [], total: 0 });
  });

  it('returns undefined for 204 No Content response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    });

    const result = await apiFetch('/dashboard/executions/123/rerun', { method: 'POST' });
    expect(result).toBeUndefined();
  });

  it('throws ApiError with status code when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({ error: 'not found' }),
    });

    await expect(apiFetch('/dashboard/executions/missing')).rejects.toThrow(ApiError);

    try {
      await apiFetch('/dashboard/executions/missing');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('throws ApiError on 401 Unauthorized response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(apiFetch('/dashboard/executions')).rejects.toThrow(ApiError);

    try {
      await apiFetch('/dashboard/executions');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(401);
    }
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(apiFetch('/dashboard/test')).rejects.toThrow('Network error');
  });

  it('uses absolute URL path as-is when starting with /', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });

    await apiFetch('/custom/path');

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe('/custom/path');
  });
});

describe('ApiError', () => {
  it('has ApiError name and correct status', () => {
    const error = new ApiError('Something went wrong', 500, { detail: 'error' });
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ detail: 'error' });
    expect(error.message).toBe('Something went wrong');
  });

  it('is an instance of Error', () => {
    const error = new ApiError('test', 400);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
  });
});
