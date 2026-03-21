import { handler } from '../index';
import { publishEvent } from '../../shared/eventbridge';
import { getItem, updateItem } from '../../shared/dynamodb';
import { DeploymentApprovedEvent } from '../../shared/types';
import { Context, Callback } from 'aws-lambda';

jest.mock('../../shared/eventbridge', () => ({
  publishEvent: jest.fn(),
}));

jest.mock('../../shared/dynamodb', () => ({
  getItem: jest.fn(),
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
    jest.resetAllMocks();
    process.env.EVENT_BUS_NAME = 'test-bus';
    process.env.EXECUTIONS_TABLE_NAME = 'test-table';
    process.env.DEPLOYMENT_DELAY_MS = '0';
    process.env.CHECKPOINT_2_WAIT_MS = '0';
    process.env.DEPLOYMENT_WEBHOOK_URL = 'https://deploy.example.com';
    process.env.DEPLOYMENT_WEBHOOK_RETRIES = '0';
    process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS = '1000';
    process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN = 'test-auth-token';
    delete process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL;
    delete process.env.CALIBRATION_TABLE_NAME;
    (getItem as jest.Mock).mockResolvedValue(null);

    (globalThis as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    }) as unknown as typeof fetch;
  });

  it('publishes deployment status on success', async () => {
    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

    expect((globalThis as unknown as { fetch?: jest.Mock }).fetch).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({ deploymentStatus: 'deployed' })
    );
  });

  it('exhausts all retries when deployment webhook fails repeatedly', async () => {
    process.env.DEPLOYMENT_WEBHOOK_RETRIES = '2';

    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('failed attempt 1'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('failed attempt 2'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('failed attempt 3'),
      });

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

    expect((globalThis as unknown as { fetch?: jest.Mock }).fetch).toHaveBeenCalledTimes(3);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({
        deploymentStatus: 'failed',
        message: expect.stringContaining('failed attempt 3'),
      })
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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

    const call = fetchMock.mock.calls[0][1];
    expect(call.headers.Authorization).toBe('Bearer token');
  });

  it('fails when fetch is unavailable', async () => {
    delete (globalThis as { fetch?: unknown }).fetch;

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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
    const fetchMock = jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })
    );

    (globalThis as { fetch?: unknown }).fetch = fetchMock as unknown as typeof fetch;

    const handlerPromise = handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

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

    const handlerPromise = handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

    jest.advanceTimersByTime(10);
    await jest.runAllTimersAsync();
    await handlerPromise;

    expect(publishEvent).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('writes failed status in finally block when terminal updateItem throws after deploying', async () => {
    let updateCallCount = 0;
    (updateItem as jest.Mock).mockImplementation(() => {
      updateCallCount++;
      if (updateCallCount === 2) {
        return Promise.reject(new Error('DynamoDB terminal update failed'));
      }
      return Promise.resolve();
    });

    await expect(
      handler(
        { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('DynamoDB terminal update failed');

    // 1st call: deploying, 2nd call throws, 3rd call: finally block writes failed
    expect(updateItem).toHaveBeenCalledTimes(3);
    const thirdCallArgs = (updateItem as jest.Mock).mock.calls[2];
    expect(thirdCallArgs[2]).toMatchObject({
      status: 'failed',
      deploymentStatus: 'failed',
      deploymentMessage: expect.stringContaining('finally block'),
    });
  });

  it('logs critical error when finally-block updateItem also fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    let updateCallCount = 0;
    (updateItem as jest.Mock).mockImplementation(() => {
      updateCallCount++;
      // Both the terminal update and the finally-block fallback update throw
      if (updateCallCount >= 2) {
        return Promise.reject(new Error('DynamoDB unavailable'));
      }
      return Promise.resolve();
    });

    await expect(
      handler(
        { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('DynamoDB unavailable');

    expect(consoleSpy).toHaveBeenCalledWith(
      'CRITICAL: Failed to write terminal status in finally block',
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('throws when event bus name is missing', async () => {
    delete process.env.EVENT_BUS_NAME;

    await expect(
      handler(
        {
          'detail-type': 'deployment_approved',
          detail: baseDetail,
        } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('EVENT_BUS_NAME is required');
  });

  it('throws when executions table name is missing', async () => {
    delete process.env.EXECUTIONS_TABLE_NAME;

    await expect(
      handler(
        {
          'detail-type': 'deployment_approved',
          detail: baseDetail,
        } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('EXECUTIONS_TABLE_NAME is required');
  });

  it('throws when DEPLOYMENT_WEBHOOK_AUTH_TOKEN is missing', async () => {
    delete process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN;

    await expect(
      handler(
        {
          'detail-type': 'deployment_approved',
          detail: baseDetail,
        } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('DEPLOYMENT_WEBHOOK_AUTH_TOKEN is required but not set');
  });

  it('throws when DEPLOYMENT_WEBHOOK_AUTH_TOKEN is empty string', async () => {
    process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN = '';

    await expect(
      handler(
        {
          'detail-type': 'deployment_approved',
          detail: baseDetail,
        } as any,
        mockContext,
        mockCallback
      )
    ).rejects.toThrow('DEPLOYMENT_WEBHOOK_AUTH_TOKEN is required but not set');
  });

  it('truncates long webhook response body to 200 chars in error messages', async () => {
    const longBody = 'a'.repeat(300);
    ((globalThis as { fetch?: unknown }).fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(longBody),
    });

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const [[, , , event]] = (publishEvent as jest.Mock).mock.calls;
    // The full 300-char body must NOT appear; the 200-char truncation must appear
    expect(event.message).not.toContain('a'.repeat(201));
    expect(event.message).toContain('a'.repeat(200));
  });

  it('redacts Bearer tokens in webhook response body', async () => {
    ((globalThis as { fetch?: unknown }).fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid token: Bearer supersecrettoken123'),
    });

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const [[, , , event]] = (publishEvent as jest.Mock).mock.calls;
    expect(event.message).not.toContain('supersecrettoken123');
    expect(event.message).toContain('[REDACTED]');
  });

  it('records rollbackStatus as triggered in DynamoDB when rollback webhook succeeds', async () => {
    process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL = 'https://rollback.example.com';

    (globalThis as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('deploy failed'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('rollback ok'),
      });

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const terminalUpdate = (updateItem as jest.Mock).mock.calls[1];
    expect(terminalUpdate[2]).toMatchObject({ rollbackStatus: 'triggered' });
  });

  it('records rollbackStatus as failed in DynamoDB when rollback webhook fails', async () => {
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

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const terminalUpdate = (updateItem as jest.Mock).mock.calls[1];
    expect(terminalUpdate[2]).toMatchObject({ rollbackStatus: 'failed' });
  });

  it('records rollbackStatus as not-configured in DynamoDB when no rollback URL is set', async () => {
    ((globalThis as { fetch?: unknown }).fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('failed'),
    });

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const terminalUpdate = (updateItem as jest.Mock).mock.calls[1];
    expect(terminalUpdate[2]).toMatchObject({ rollbackStatus: 'not-configured' });
  });

  it('allows deployment to proceed when Checkpoint 2 score is below threshold', async () => {
    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    expect((globalThis as { fetch?: jest.Mock }).fetch).toHaveBeenCalledTimes(1);
    expect(updateItem).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({ deploymentStatus: 'deployed' })
    );
  });

  it('blocks deployment and writes deployment-blocked status when Checkpoint 2 score is ≥ 40', async () => {
    const highRiskDetail = { ...baseDetail, riskScore: 40 };

    await handler(
      { 'detail-type': 'deployment_approved', detail: highRiskDetail } as any,
      mockContext,
      mockCallback
    );

    // Deployment webhook must NOT be called when blocked
    expect((globalThis as { fetch?: jest.Mock }).fetch).not.toHaveBeenCalled();
    expect(updateItem).toHaveBeenCalledTimes(2);
    const secondCall = (updateItem as jest.Mock).mock.calls[1];
    expect(secondCall[2]).toMatchObject({
      status: 'deployment-blocked',
      checkpoints: [expect.objectContaining({ type: 'pre-deploy', decision: 'held' })],
    });
  });

  it('includes checkpoint2 in terminal updateItem when deployment succeeds', async () => {
    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const terminalCall = (updateItem as jest.Mock).mock.calls[1];
    expect(terminalCall[2]).toMatchObject({
      status: 'monitoring',
      checkpoints: [expect.objectContaining({ type: 'pre-deploy' })],
    });
  });

  it('respects Checkpoint 2 wait delay before evaluating risk', async () => {
    jest.useFakeTimers();
    process.env.CHECKPOINT_2_WAIT_MS = '10';

    const handlerPromise = handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    jest.advanceTimersByTime(10);
    await jest.runAllTimersAsync();
    await handlerPromise;

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({ deploymentStatus: 'deployed' })
    );
    jest.useRealTimers();
  });

  it('defaults calibration factor to 1.0 when calibration record is absent', async () => {
    process.env.CALIBRATION_TABLE_NAME = 'cal-table';
    // getItem returns null → calibrationFactor defaults to 1.0, score stays low
    (getItem as jest.Mock).mockResolvedValue(null);

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    expect(publishEvent).toHaveBeenCalledWith(
      'test-bus',
      'pullmint.orchestrator',
      'deployment.status',
      expect.objectContaining({ deploymentStatus: 'deployed' })
    );
  });

  it('uses calibration factor from DynamoDB to block deployment when CALIBRATION_TABLE_NAME is set', async () => {
    process.env.CALIBRATION_TABLE_NAME = 'cal-table';
    // calibrationFactor=2.0, riskScore=25 → score = 25 * 2.0 = 50 ≥ 40 → blocked
    (getItem as jest.Mock).mockResolvedValue({ calibrationFactor: 2.0 });
    const moderateRiskDetail = { ...baseDetail, riskScore: 25 };

    await handler(
      { 'detail-type': 'deployment_approved', detail: moderateRiskDetail } as any,
      mockContext,
      mockCallback
    );

    expect((globalThis as { fetch?: jest.Mock }).fetch).not.toHaveBeenCalled();
    const secondCall = (updateItem as jest.Mock).mock.calls[1];
    expect(secondCall[2]).toMatchObject({ status: 'deployment-blocked' });
    expect(getItem).toHaveBeenCalledWith('cal-table', { repoFullName: 'owner/repo' });
  });

  it('should skip webhook call if execution already has deploymentStartedAt', async () => {
    // Execution already marked as deploying from a prior Lambda invocation
    (getItem as jest.Mock).mockResolvedValue({
      executionId: 'exec-123',
      status: 'deploying',
      deploymentStartedAt: Date.now() - 5000,
      riskScore: 20,
      repoFullName: 'owner/repo',
      prNumber: 42,
    });

    await handler(
      {
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any,
      mockContext,
      mockCallback
    );

    // Webhook should NOT have been called — this is a duplicate invocation
    expect((globalThis as { fetch?: jest.Mock }).fetch).not.toHaveBeenCalled();
    // Should not update status or publish events
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('merges prior checkpoint1 with checkpoint2 in the terminal updateItem call', async () => {
    const priorCheckpoint = {
      type: 'analysis',
      score: 20,
      confidence: 0.5,
      missingSignals: [],
      signals: [],
      decision: 'approved',
      reason: 'ok',
      evaluatedAt: 0,
    };
    // First getItem call: idempotency guard (no deploymentStartedAt → proceed)
    // Second getItem call: runCheckpoint2 fetches prior checkpoints
    (getItem as jest.Mock)
      .mockResolvedValueOnce({ checkpoints: [priorCheckpoint] })
      .mockResolvedValueOnce({ checkpoints: [priorCheckpoint] });

    await handler(
      { 'detail-type': 'deployment_approved', detail: baseDetail } as any,
      mockContext,
      mockCallback
    );

    const terminalCall = (updateItem as jest.Mock).mock.calls[1];
    const checkpoints = terminalCall[2].checkpoints as unknown[];
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ type: 'analysis' });
    expect(checkpoints[1]).toMatchObject({ type: 'pre-deploy' });
  });
});
