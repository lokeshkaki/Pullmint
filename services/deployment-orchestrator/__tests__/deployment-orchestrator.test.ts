import { handler } from '../index';
import { publishEvent } from '../../shared/eventbridge';
import { updateItem } from '../../shared/dynamodb';
import { DeploymentApprovedEvent } from '../../shared/types';

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

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVENT_BUS_NAME = 'test-bus';
    process.env.EXECUTIONS_TABLE_NAME = 'test-table';
    process.env.DEPLOYMENT_RESULT = 'success';
    process.env.DEPLOYMENT_DELAY_MS = '0';
  });

  it('publishes deployment status on success', async () => {
    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any);

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
    delete process.env.DEPLOYMENT_RESULT;
    delete process.env.DEPLOYMENT_DELAY_MS;

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any);

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
    process.env.DEPLOYMENT_RESULT = 'fail';

    await handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any);

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

  it('respects deployment delay', async () => {
    jest.useFakeTimers();
    process.env.DEPLOYMENT_DELAY_MS = '10';

    const handlerPromise = handler({
      'detail-type': 'deployment_approved',
      detail: baseDetail,
    } as any);

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
      } as any)
    ).rejects.toThrow('EVENT_BUS_NAME is required');
  });

  it('throws when executions table name is missing', async () => {
    delete process.env.EXECUTIONS_TABLE_NAME;

    await expect(
      handler({
        'detail-type': 'deployment_approved',
        detail: baseDetail,
      } as any)
    ).rejects.toThrow('EXECUTIONS_TABLE_NAME is required');
  });
});
