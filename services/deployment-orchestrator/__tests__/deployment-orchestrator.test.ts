import { handler } from '../index';
import { publishEvent } from '../../shared/eventbridge';
import { updateItem } from '../../shared/dynamodb';
import { DeploymentApprovedEvent } from '../../shared/types';
import { Context, Callback } from 'aws-lambda';

jest.mock('../../shared/eventbridge', () => ({
  publishEvent: jest.fn(),
}));

jest.mock('../../shared/dynamodb', () => ({
  updateItem: jest.fn(),
}));

describe('Deployment Orchestrator', () => {
  const baseDetail: DeploymentApprovedEvent = {
    executionId: 'exec-123',
    prNumber: 42,
    repoFullName: 'owner/repo',
    headSha: 'abc123',
    baseSha: 'def456',
    author: 'octocat',
    title: 'Add feature',
    orgId: 'org_1',
    riskScore: 10,
    deploymentEnvironment: 'staging',
    deploymentStrategy: 'eventbridge',
  };

  const mockContext = {} as Context;
  const mockCallback = (() => {}) as Callback<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENT_BUS_NAME = 'test-bus';
    process.env.EXECUTIONS_TABLE_NAME = 'test-table';
    process.env.DEPLOYMENT_DELAY_MS = '0';
    process.env.DEPLOYMENT_WEBHOOK_URL = 'https://deploy.example.com';
    process.env.DEPLOYMENT_WEBHOOK_RETRIES = '0';
    process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS = '1000';
    process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN = '';
    delete process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL;

    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    }) as unknown as typeof fetch;
  });

  it('publishes deployment status on success', async () => {
    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(updateItem).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        executionId: baseDetail.executionId,
        deploymentStatus: 'deployed',
      })
    );
  });

  it('uses default config values when env is unset', async () => {
    delete process.env.DEPLOYMENT_DELAY_MS;
    delete process.env.DEPLOYMENT_WEBHOOK_RETRIES;
    delete process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'deployed',
      })
    );
  });

  it('publishes deployment status on failure', async () => {
    ((globalThis as { fetch?: unknown }).fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('failed'),
    });

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(updateItem).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        executionId: baseDetail.executionId,
        deploymentStatus: 'failed',
      })
    );
  });

  it('handles non-error exceptions from the deployment webhook', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() => {
      throw 'boom';
    }) as unknown as typeof fetch;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('boom'),
      })
    );
  });

  it('fails when webhook retry count is not a number', async () => {
    process.env.DEPLOYMENT_WEBHOOK_RETRIES = 'NaN';

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect((globalThis as unknown as { fetch?: jest.Mock }).fetch).not.toHaveBeenCalled();
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('Deployment webhook failed'),
      })
    );
  });

  it('fails when deployment webhook URL is missing', async () => {
    delete process.env.DEPLOYMENT_WEBHOOK_URL;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: 'Deployment webhook URL is not configured',
      })
    );
  });

  it('retries deployment webhook before succeeding', async () => {
    process.env.DEPLOYMENT_WEBHOOK_RETRIES = '1';

    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('failed'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      });

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect((globalThis as unknown as { fetch?: jest.Mock }).fetch).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({ deploymentStatus: 'deployed' })
    );
  });

  it('triggers rollback on deployment failure', async () => {
    process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL = 'https://rollback.example.com';

    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('failed'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('ok'),
      });

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect((globalThis as unknown as { fetch?: jest.Mock }).fetch).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('Rollback triggered'),
      })
    );
  });

  it('records rollback failures', async () => {
    process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL = 'https://rollback.example.com';

    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('deploy failed'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('rollback failed'),
      });

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('Rollback failed'),
      })
    );
  });

  it('sends webhook auth header when configured', async () => {
    process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN = 'token';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    const call = fetchMock.mock.calls[0][1];
    expect(call.headers.Authorization).toBe('Bearer token');
  });

  it('fails when fetch is unavailable', async () => {
    delete (globalThis as { fetch?: unknown }).fetch;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('Fetch is not available'),
      })
    );
  });

  it('aborts webhook requests after the timeout', async () => {
    jest.useFakeTimers();
    process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS = '5';
    const fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })
    );

    (globalThis as { fetch?: unknown }).fetch = fetchMock as unknown as typeof fetch;

    const handlerPromise = handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    jest.advanceTimersByTime(5);
    await jest.runAllTimersAsync();
    await handlerPromise;

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('aborted'),
      })
    );
    jest.useRealTimers();
  });

  it('respects deployment delay', async () => {
    jest.useFakeTimers();
    process.env.DEPLOYMENT_DELAY_MS = '10';

    const handlerPromise = handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any, mockContext, mockCallback);

    jest.advanceTimersByTime(10);
    await jest.runAllTimersAsync();
    await handlerPromise;

    expect(publishEvent).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('throws when event bus name is missing', async () => {
    delete process.env.EVENT_BUS_NAME;

    await expect(
      handler({
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any, mockContext, mockCallback)
    ).rejects.toThrow('EVENT_BUS_NAME is required');
  });

  it('throws when executions table name is missing', async () => {
    delete process.env.EXECUTIONS_TABLE_NAME;

    await expect(
      handler({
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any, mockContext, mockCallback)
    ).rejects.toThrow('EXECUTIONS_TABLE_NAME is required');
  });
});
