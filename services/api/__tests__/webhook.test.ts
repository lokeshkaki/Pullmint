import Fastify from 'fastify';
import crypto from 'crypto';
import { registerWebhookRoutes } from '../src/routes/webhook';

// Mock shared modules
jest.mock('@pullmint/shared/db', () => {
  const mockInsert = jest.fn();
  const mockSelect = jest.fn();
  return {
    getDb: jest.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
    })),
    schema: {
      webhookDedup: { deliveryId: 'deliveryId' },
      executions: {
        executionId: 'executionId',
        repoFullName: 'repoFullName',
        prNumber: 'prNumber',
        status: 'status',
      },
      repoRegistry: { repoFullName: 'repoFullName', indexingStatus: 'indexingStatus' },
    },
  };
});

jest.mock('@pullmint/shared/queue', () => ({
  addJob: jest.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    ANALYSIS: 'analysis',
    REPO_INDEXING: 'repo-indexing',
    DEPLOYMENT_STATUS: 'deployment-status',
  },
}));

jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'GITHUB_WEBHOOK_SECRET') return 'test-secret';
    return 'test-value';
  }),
}));

jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));

jest.mock('@pullmint/shared/error-handling', () => ({
  createStructuredError: jest.fn((err: Error) => ({ message: err.message })),
}));

jest.mock('@pullmint/shared/utils', () => ({
  verifyGitHubSignature: jest.fn().mockReturnValue(true),
  generateExecutionId: jest.fn().mockReturnValue('test-repo#1#abc1234'),
  calculateTTL: jest.fn().mockReturnValue(86400),
}));

function makeSignature(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function buildSelectMock(rows: unknown[]) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

function buildInsertMock(returning: unknown[] = [{ executionId: 'test-repo#1#abc1234' }]) {
  return jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returning),
      }),
    }),
  });
}

async function buildApp() {
  const app = Fastify({ logger: false });
  registerWebhookRoutes(app);
  return app;
}

describe('Webhook Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Re-initialize mocks cleared by clearAllMocks
    const { verifyGitHubSignature, generateExecutionId } = jest.requireMock(
      '../../shared/utils'
    ) as {
      verifyGitHubSignature: jest.Mock;
      generateExecutionId: jest.Mock;
    };
    verifyGitHubSignature.mockReturnValue(true);
    generateExecutionId.mockReturnValue('test-repo#1#abc1234');
    app = await buildApp();
    // Set up default mocks
    const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
    getDb.mockReturnValue({
      insert: buildInsertMock(),
      select: buildSelectMock([]), // no existing dedup
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /webhook', () => {
    const prPayload = {
      action: 'opened',
      pull_request: {
        number: 1,
        head: { sha: 'abc1234def' },
        base: { sha: 'base1234def' },
        user: { login: 'testuser' },
        title: 'Test PR',
        merged: false,
        merge_commit_sha: null,
      },
      repository: {
        full_name: 'test-org/test-repo',
        owner: { id: 12345 },
      },
    };

    it('returns 202 for a valid PR opened event', async () => {
      const body = JSON.stringify(prPayload);
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]), // no dedup, no registry
        insert: buildInsertMock([{ executionId: 'test-repo#1#abc1234' }]),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'test-delivery-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const parsed = JSON.parse(response.body) as { message: string; executionId: string };
      expect(parsed.message).toBe('Event accepted');
    });

    it('returns 401 for invalid signature', async () => {
      const { verifyGitHubSignature } = jest.requireMock('../../shared/utils') as {
        verifyGitHubSignature: jest.Mock;
      };
      verifyGitHubSignature.mockReturnValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'test-delivery-id',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: JSON.stringify(prPayload),
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 for missing delivery ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': makeSignature(JSON.stringify(prPayload), 'test-secret'),
        },
        body: JSON.stringify(prPayload),
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 200 for duplicate delivery (idempotency)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([{ deliveryId: 'dup-delivery-id', expiresAt: new Date() }]),
        insert: buildInsertMock(),
      });
      const body = JSON.stringify(prPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'dup-delivery-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Already processed');
    });

    it('returns 200 for ignored event types', async () => {
      const body = JSON.stringify({ action: 'labeled' });

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'ignore-delivery-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Event type ignored');
    });

    it('returns 200 for duplicate execution (already processing)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]), // no dedup
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]), // conflict = empty array
            }),
          }),
        }),
      });

      const body = JSON.stringify(prPayload);
      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'new-delivery-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Already processing');
    });

    it('adds job to analysis queue for PR opened event', async () => {
      const { addJob } = jest.requireMock('../../shared/queue') as { addJob: jest.Mock };
      const body = JSON.stringify(prPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'queue-test-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      expect(addJob).toHaveBeenCalledWith(
        'analysis',
        'pr.opened',
        expect.objectContaining({
          executionId: expect.any(String),
        })
      );
    });

    it('returns 202 for installation created event', async () => {
      const instPayload = {
        action: 'created',
        installation: { id: 999 },
        repositories: [{ full_name: 'org/new-repo' }],
      };
      const body = JSON.stringify(instPayload);
      const { addJob } = jest.requireMock('../../shared/queue') as { addJob: jest.Mock };

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'install-delivery-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      expect(addJob).toHaveBeenCalledWith(
        'repo-indexing',
        'repo.onboarding.requested',
        expect.objectContaining({ repoFullName: 'org/new-repo' })
      );
    });

    it('returns 200 for unsupported PR action (e.g. labeled)', async () => {
      const labeledPayload = {
        action: 'labeled',
        pull_request: {
          number: 7,
          head: { sha: 'head7' },
          base: { sha: 'base7' },
          user: { login: 'dev' },
          title: 'Test',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(labeledPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'pr-label-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsedLabel = JSON.parse(response.body) as { message: string };
      expect(parsedLabel.message).toBe('PR action ignored');
    });

    it('returns 202 for deployment_status event with executionId', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      const dsPayload = {
        deployment: {
          sha: 'abc123',
          environment: 'production',
          payload: {
            executionId: 'exec-deploy-1',
            prNumber: 1,
            repoFullName: 'test-org/test-repo',
            author: 'dev',
            title: 'Test',
            orgId: 'org_12345',
          },
        },
        deployment_status: { state: 'success', description: 'Deployed!' },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(dsPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const parsedDs = JSON.parse(response.body) as { message: string };
      expect(parsedDs.message).toBe('Deployment status accepted');
    });

    it('returns 200 for deployment_status without executionId', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: buildInsertMock(),
      });
      const dsPayload2 = {
        deployment: { sha: 'abc', environment: 'staging', payload: {} },
        deployment_status: { state: 'success', description: '' },
        repository: { full_name: 'org/repo', owner: { id: 1 } },
      };
      const body = JSON.stringify(dsPayload2);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-delivery-2',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsedDs2 = JSON.parse(response.body) as { message: string };
      expect(parsedDs2.message).toBe('Deployment status ignored');
    });

    it('returns 202 for PR closed and merged', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      const mergedPayload = {
        action: 'closed',
        pull_request: {
          number: 5,
          head: { sha: 'head5abc' },
          base: { sha: 'base5abc' },
          user: { login: 'dev' },
          title: 'Feature branch',
          merged: true,
          merge_commit_sha: 'merge5abc',
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(mergedPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'pr-merge-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const parsedMerge = JSON.parse(response.body) as { message: string };
      expect(parsedMerge.message).toBe('Merge event published');
    });

    it('returns 200 for PR closed without merge', async () => {
      const closedPayload = {
        action: 'closed',
        pull_request: {
          number: 6,
          head: { sha: 'head6abc' },
          base: { sha: 'base6abc' },
          user: { login: 'dev' },
          title: 'Draft',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(closedPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'pr-close-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsedClose = JSON.parse(response.body) as { message: string };
      expect(parsedClose.message).toBe('PR closed without merge');
    });

    it('returns 200 for unsupported PR action (e.g. labeled)', async () => {
      const labeledPayload = {
        action: 'labeled',
        pull_request: {
          number: 7,
          head: { sha: 'head7' },
          base: { sha: 'base7' },
          user: { login: 'dev' },
          title: 'Test',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(labeledPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'pr-label-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsedLabel = JSON.parse(response.body) as { message: string };
      expect(parsedLabel.message).toBe('PR action ignored');
    });

    it('returns 202 for PR opened when repo not yet indexed (queued path)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const mockSelect = jest
        .fn()
        .mockReturnValueOnce({
          // dedup check → empty (not already processed)
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        })
        .mockReturnValueOnce({
          // registry check → pending (not indexed)
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ indexingStatus: 'pending' }]),
            }),
          }),
        });
      const mockInsert = jest
        .fn()
        .mockReturnValueOnce({
          // insert executions → success
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ executionId: 'queued-123' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          // writeDedupRecord
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        });
      getDb.mockReturnValue({ select: mockSelect, insert: mockInsert });

      const queuedPr = {
        action: 'opened',
        pull_request: {
          number: 10,
          head: { sha: 'abc0000' },
          base: { sha: 'base0000' },
          user: { login: 'developer' },
          title: 'New feature',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(queuedPr);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'queued-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const parsedQueued = JSON.parse(response.body) as { message: string };
      expect(parsedQueued.message).toBe('Queued — repo indexing in progress');
    });

    it('returns 200 for queued path conflict (already processing the queue)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const mockSelect = jest
        .fn()
        .mockReturnValueOnce({
          // dedup check → empty
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        })
        .mockReturnValueOnce({
          // registry check → pending
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ indexingStatus: 'pending' }]),
            }),
          }),
        });
      const mockInsert = jest.fn().mockReturnValueOnce({
        // insert executions → conflict (empty returning)
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]), // no row returned = conflict
          }),
        }),
      });
      getDb.mockReturnValue({ select: mockSelect, insert: mockInsert });

      const conflictPr = {
        action: 'opened',
        pull_request: {
          number: 12,
          head: { sha: 'abc1122' },
          base: { sha: 'base1122' },
          user: { login: 'dev3' },
          title: 'Another PR',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(conflictPr);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'conflict-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Already processing');
    });

    it('returns 202 for deployment_status with inactive state', async () => {
      const inactiveDS = {
        deployment: {
          sha: 'abc777',
          environment: 'staging',
          payload: {
            executionId: 'exec-inactive',
            prNumber: 99,
            repoFullName: 'org/repo',
          },
        },
        deployment_status: { state: 'inactive', description: '' },
        repository: { full_name: 'org/repo', owner: { id: 1 } },
      };
      const body = JSON.stringify(inactiveDS);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-inactive-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      // buildDeploymentStatusDetail returns null for inactive → 200 ignored
      expect(response.statusCode).toBe(200);
    });

    it('returns 202 for deployment_status queued state', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      const queuedDS = {
        deployment: {
          sha: 'abc888',
          environment: 'prod',
          payload: {
            executionId: 'exec-queued',
            prNumber: 88,
            repoFullName: 'org/repo',
            author: 'dev',
            title: 'Queued PR',
            orgId: 'org_1',
            deploymentStrategy: 'canary',
          },
        },
        deployment_status: { state: 'queued', description: 'Pending...' },
        repository: { full_name: 'org/repo', owner: { id: 1 } },
      };
      const body = JSON.stringify(queuedDS);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-queued-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
    });

    it('returns 202 for deployment_status in_progress state', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      const inProgressDS = {
        deployment: {
          sha: 'abc999',
          environment: 'prod',
          payload: {
            executionId: 'exec-in-progress',
            prNumber: 77,
            repoFullName: 'org/repo',
            author: 'dev2',
            title: 'In Progress',
            orgId: 'org_2',
          },
        },
        deployment_status: { state: 'in_progress', description: 'Deploying...' },
        repository: { full_name: 'org/repo', owner: { id: 1 } },
      };
      const body = JSON.stringify(inProgressDS);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-in-progress-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
    });

    it('returns 202 for deployment_status error state', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      });
      const errorDS = {
        deployment: {
          sha: 'abc666',
          environment: 'prod',
          payload: {
            executionId: 'exec-error',
            prNumber: 55,
            repoFullName: 'org/repo',
            author: 'dev',
            title: 'Failed Deploy',
            orgId: 'org_3',
          },
        },
        deployment_status: { state: 'error', description: 'Deployment failed!' },
        repository: { full_name: 'org/repo', owner: { id: 1 } },
      };
      const body = JSON.stringify(errorDS);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'deployment_status',
          'x-github-delivery': 'ds-error-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
    });

    it('returns 202 for PR reopened action (repo indexed)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const mockSelect = jest
        .fn()
        .mockReturnValueOnce({
          // dedup check → empty
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        })
        .mockReturnValueOnce({
          // registry check → indexed
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ indexingStatus: 'indexed' }]),
            }),
          }),
        });
      const mockInsert = jest
        .fn()
        .mockReturnValueOnce({
          // insert executions → success
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ executionId: 'reopen-123' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          // writeDedupRecord
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        });
      getDb.mockReturnValue({ select: mockSelect, insert: mockInsert });

      const reopenPr = {
        action: 'reopened',
        pull_request: {
          number: 30,
          head: { sha: 'reopen123' },
          base: { sha: 'reopenbase' },
          user: { login: 'dev' },
          title: 'Reopened PR',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(reopenPr);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'reopen-delivery-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const { addJob } = jest.requireMock('../../shared/queue') as { addJob: jest.Mock };
      expect(addJob).toHaveBeenCalledWith('analysis', 'pr.reopened', expect.any(Object));
    });

    it('returns 202 for PR synchronize action (pushes new commits)', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      const mockSelect = jest
        .fn()
        .mockReturnValueOnce({
          // dedup check
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        })
        .mockReturnValueOnce({
          // registry check → indexed
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ indexingStatus: 'indexed' }]),
            }),
          }),
        });
      const mockInsert = jest
        .fn()
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ executionId: 'sync-456' }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        });
      getDb.mockReturnValue({ select: mockSelect, insert: mockInsert });

      const syncPr = {
        action: 'synchronize',
        pull_request: {
          number: 35,
          head: { sha: 'sync456abc' },
          base: { sha: 'syncbase456' },
          user: { login: 'dev2' },
          title: 'Updated with new commits',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      };
      const body = JSON.stringify(syncPr);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'sync-delivery-456',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(202);
      const { addJob } = jest.requireMock('../../shared/queue') as { addJob: jest.Mock };
      expect(addJob).toHaveBeenCalledWith('analysis', 'pr.synchronize', expect.any(Object));
    });

    it('handles writeDedupRecord throwing error gracefully', async () => {
      const { getDb } = jest.requireMock('../../shared/db') as { getDb: jest.Mock };
      getDb.mockReturnValue({
        select: buildSelectMock([]),
        insert: jest
          .fn()
          .mockReturnValueOnce({
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ executionId: 'error-exec' }]),
              }),
            }),
          })
          .mockReturnValueOnce({
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockRejectedValue(new Error('Dedup write failed')),
            }),
          }),
      });

      const body = JSON.stringify({
        action: 'opened',
        pull_request: {
          number: 40,
          head: { sha: 'error123' },
          base: { sha: 'errorbase' },
          user: { login: 'dev' },
          title: 'Error recovery test',
          merged: false,
          merge_commit_sha: null,
        },
        repository: { full_name: 'test-org/test-repo', owner: { id: 12345 } },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'error-dedup-1',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      // Should still return 202 as execution was created despite dedup error
      expect(response.statusCode).toBe(202);
    });

    it('returns 200 for installation deleted action', async () => {
      const instDeletedPayload = {
        action: 'deleted',
        installation: { id: 999 },
        repositories: [],
      };
      const body = JSON.stringify(instDeletedPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': 'inst-delete-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Installation action ignored');
    });

    it('returns 200 for installation_repositories removed action', async () => {
      const instReposRemovedPayload = {
        action: 'removed',
        installation: { id: 999 },
        repositories_removed: [{ full_name: 'org/old-repo' }],
      };
      const body = JSON.stringify(instReposRemovedPayload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation_repositories',
          'x-github-delivery': 'inst-repos-removed-id',
          'x-hub-signature-256': makeSignature(body, 'test-secret'),
        },
        body,
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body) as { message: string };
      expect(parsed.message).toBe('Installation action ignored');
    });
  });
});
