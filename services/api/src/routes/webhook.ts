import { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig } from '@pullmint/shared/config';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { verifyGitHubSignature, generateExecutionId } from '@pullmint/shared/utils';
import { createStructuredError } from '@pullmint/shared/error-handling';
import { eq } from 'drizzle-orm';
import {
  GitHubPRPayload,
  GitHubDeploymentStatusPayload,
  PREvent,
  PRExecution,
  DeploymentStatusEvent,
} from '@pullmint/shared/types';
import type { PRMergedEvent } from '@pullmint/shared/types';

function mapDeploymentStatus(
  state: GitHubDeploymentStatusPayload['deployment_status']['state']
): 'deploying' | 'deployed' | 'failed' | null {
  if (state === 'success') {
    return 'deployed';
  }
  if (state === 'queued' || state === 'in_progress') {
    return 'deploying';
  }
  if (state === 'inactive') {
    return null;
  }
  return 'failed';
}

function buildDeploymentStatusDetail(
  payload: GitHubDeploymentStatusPayload
): DeploymentStatusEvent | null {
  const deploymentPayload = payload.deployment.payload || {};
  const executionId = deploymentPayload.executionId;
  const prNumber = deploymentPayload.prNumber;
  const repoFullName = deploymentPayload.repoFullName || payload.repository.full_name;

  if (!executionId || !prNumber) {
    console.log('Deployment status missing executionId or prNumber, ignoring.');
    return null;
  }

  const deploymentStatus = mapDeploymentStatus(payload.deployment_status.state);

  if (deploymentStatus === null) {
    console.log('Deployment status is inactive, ignoring.');
    return null;
  }

  const deploymentEnvironment = payload.deployment.environment;
  const deploymentStrategy = deploymentPayload.deploymentStrategy || 'deployment';

  return {
    executionId,
    prNumber,
    repoFullName,
    headSha: payload.deployment.sha,
    baseSha: deploymentPayload.baseSha || '',
    author: deploymentPayload.author || 'unknown',
    title: deploymentPayload.title || 'Deployment update',
    orgId: deploymentPayload.orgId || `org_${payload.repository.owner.id}`,
    deploymentEnvironment,
    deploymentStrategy,
    deploymentStatus,
    message: payload.deployment_status.description,
  };
}

async function writeDedupRecord(db: ReturnType<typeof getDb>, deliveryId: string): Promise<void> {
  try {
    await db
      .insert(schema.webhookDedup)
      .values({
        deliveryId,
        expiresAt: new Date(Date.now() + 86400 * 1000),
      })
      .onConflictDoNothing();
  } catch {
    console.warn(`Dedup write failed for ${deliveryId} — execution record provides idempotency`);
  }
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  // Register content type parser to preserve raw body for HMAC validation
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest & { rawBody?: string }, body: string, done) => {
      req.rawBody = body;
      try {
        const json = JSON.parse(body) as unknown;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.post('/webhook', async (request, reply) => {
    const req = request as FastifyRequest & { rawBody?: string };
    try {
      // 1. Verify GitHub signature
      const signature =
        (request.headers['x-hub-signature-256'] as string | undefined) ||
        (request.headers['X-Hub-Signature-256'] as string | undefined);
      const webhookSecret = getConfig('GITHUB_WEBHOOK_SECRET');

      if (!verifyGitHubSignature(req.rawBody || '', signature, webhookSecret)) {
        console.error('Invalid GitHub signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // 2. Parse event
      const eventType =
        (request.headers['x-github-event'] as string | undefined) ||
        (request.headers['X-GitHub-Event'] as string | undefined);
      const payload: unknown = request.body;

      // 3. Filter relevant events
      const ACCEPTED_EVENT_TYPES = new Set([
        'pull_request',
        'deployment_status',
        'installation',
        'installation_repositories',
      ]);
      if (!ACCEPTED_EVENT_TYPES.has(eventType ?? '')) {
        console.log(`Ignoring event type: ${eventType}`);
        return reply.status(200).send({ message: 'Event type ignored' });
      }

      // 4. Idempotency check
      const deliveryId =
        (request.headers['x-github-delivery'] as string | undefined) ||
        (request.headers['X-GitHub-Delivery'] as string | undefined);
      if (!deliveryId) {
        console.error('Missing delivery ID');
        return reply.status(400).send({ error: 'Missing delivery ID' });
      }

      const db = getDb();

      // Check if already processed
      const existingDedup = await db
        .select()
        .from(schema.webhookDedup)
        .where(eq(schema.webhookDedup.deliveryId, deliveryId))
        .limit(1);
      if (existingDedup.length > 0) {
        console.log(`Duplicate delivery: ${deliveryId}`);
        return reply.status(200).send({ message: 'Already processed' });
      }

      // Handle installation events (GitHub App install / repo added)
      if (eventType === 'installation' || eventType === 'installation_repositories') {
        const instPayload = payload as {
          action: string;
          installation: { id: number };
          repositories?: Array<{ full_name: string }>;
          repositories_added?: Array<{ full_name: string }>;
        };

        const isRelevantAction =
          (eventType === 'installation' && instPayload.action === 'created') ||
          (eventType === 'installation_repositories' && instPayload.action === 'added');

        if (!isRelevantAction) {
          console.log(`Ignoring installation action: ${instPayload.action}`);
          return reply.status(200).send({ message: 'Installation action ignored' });
        }

        const repos =
          eventType === 'installation'
            ? (instPayload.repositories ?? [])
            : (instPayload.repositories_added ?? []);

        await Promise.all(
          repos.map((r) =>
            addJob(QUEUE_NAMES.REPO_INDEXING, 'repo.onboarding.requested', {
              repoFullName: r.full_name,
              installationId: instPayload.installation.id,
            })
          )
        );
        await writeDedupRecord(db, deliveryId);
        return reply.status(202).send({ message: 'Onboarding triggered' });
      }

      if (eventType === 'pull_request') {
        const prPayload = payload as GitHubPRPayload;

        if (!['opened', 'synchronize', 'reopened', 'closed'].includes(prPayload.action)) {
          console.log(`Ignoring PR action: ${prPayload.action}`);
          return reply.status(200).send({ message: 'PR action ignored' });
        }

        // Handle merged PR
        if (prPayload.action === 'closed') {
          if (!prPayload.pull_request.merged) {
            return reply.status(200).send({ message: 'PR closed without merge' });
          }

          // Best-effort executionId lookup via DB query
          let executionId: string | undefined;
          try {
            // Filter in-memory for PR number since both are needed
            const byPr = await db
              .select({ executionId: schema.executions.executionId })
              .from(schema.executions)
              .where(eq(schema.executions.prNumber, prPayload.pull_request.number))
              .limit(1);
            executionId = byPr[0]?.executionId;
          } catch {
            /* best effort */
          }

          const mergedEvent: PRMergedEvent = {
            repoFullName: prPayload.repository.full_name,
            prNumber: prPayload.pull_request.number,
            headSha: prPayload.pull_request.merge_commit_sha ?? prPayload.pull_request.head.sha,
            author: prPayload.pull_request.user.login,
            mergedAt: Date.now(),
            executionId,
          };
          await addJob(
            QUEUE_NAMES.REPO_INDEXING,
            'pr.merged',
            mergedEvent as unknown as Record<string, unknown>
          );
          await writeDedupRecord(db, deliveryId);
          return reply.status(202).send({ message: 'Merge event published' });
        }

        // Create PR event
        const prEvent: PREvent = {
          prNumber: prPayload.pull_request.number,
          repoFullName: prPayload.repository.full_name,
          headSha: prPayload.pull_request.head.sha,
          baseSha: prPayload.pull_request.base.sha,
          author: prPayload.pull_request.user.login,
          title: prPayload.pull_request.title,
          orgId: `org_${prPayload.repository.owner.id}`,
        };

        // Check if repo is indexed; queue execution if not
        // Always check Postgres repoRegistry for indexing status
        {
          const registryRows = await db
            .select({ indexingStatus: schema.repoRegistry.indexingStatus })
            .from(schema.repoRegistry)
            .where(eq(schema.repoRegistry.repoFullName, prEvent.repoFullName))
            .limit(1);
          const registry = registryRows[0];
          if (registry && registry.indexingStatus !== 'indexed') {
            const queuedExecutionId = generateExecutionId(
              prEvent.repoFullName,
              prEvent.prNumber,
              prEvent.headSha
            );
            const queuedExecution = {
              executionId: queuedExecutionId,
              repoFullName: prEvent.repoFullName,
              prNumber: prEvent.prNumber,
              headSha: prEvent.headSha,
              status: 'pending' as const,
            };
            const inserted = await db
              .insert(schema.executions)
              .values(queuedExecution)
              .onConflictDoNothing()
              .returning({ executionId: schema.executions.executionId });
            if (inserted.length === 0) {
              return reply.status(200).send({ message: 'Already processing' });
            }
            await writeDedupRecord(db, deliveryId);
            return reply.status(202).send({
              message: 'Queued — repo indexing in progress',
              executionId: queuedExecutionId,
            });
          }
        }

        // Create execution record
        const executionId = generateExecutionId(
          prEvent.repoFullName,
          prEvent.prNumber,
          prEvent.headSha
        );
        addTraceAnnotations({ executionId, prNumber: prEvent.prNumber });

        const execution: PRExecution = {
          executionId,
          repoFullName: prEvent.repoFullName,
          repoPrKey: `${prEvent.repoFullName}#${prEvent.prNumber}`,
          prNumber: prEvent.prNumber,
          headSha: prEvent.headSha,
          status: 'pending',
          timestamp: Date.now(),
          entityType: 'execution',
        };

        const inserted = await db
          .insert(schema.executions)
          .values({
            executionId: execution.executionId,
            repoFullName: execution.repoFullName,
            prNumber: execution.prNumber,
            headSha: execution.headSha,
            status: execution.status,
          })
          .onConflictDoNothing()
          .returning({ executionId: schema.executions.executionId });

        if (inserted.length === 0) {
          console.warn(
            `Execution record already exists for ${executionId} — skipping duplicate write`
          );
          return reply.status(200).send({ message: 'Already processing' });
        }

        // Publish to BullMQ
        await addJob(QUEUE_NAMES.ANALYSIS, `pr.${prPayload.action}`, {
          ...prEvent,
          executionId,
        });

        console.log(`Published event for PR #${prEvent.prNumber} in ${prEvent.repoFullName}`);
        await writeDedupRecord(db, deliveryId);

        return reply.status(202).send({
          message: 'Event accepted',
          executionId,
        });
      }

      const deploymentPayload = payload as GitHubDeploymentStatusPayload;
      const deploymentDetail = buildDeploymentStatusDetail(deploymentPayload);

      if (!deploymentDetail) {
        return reply.status(200).send({ message: 'Deployment status ignored' });
      }

      await addJob(
        QUEUE_NAMES.DEPLOYMENT_STATUS,
        'deployment.status',
        deploymentDetail as unknown as Record<string, unknown>
      );

      await writeDedupRecord(db, deliveryId);

      return reply.status(202).send({ message: 'Deployment status accepted' });
    } catch (error) {
      const structuredError = createStructuredError(
        error instanceof Error ? error : new Error('Unknown error'),
        {
          context: 'webhook-receiver',
          path: request.url,
          eventType: request.headers['x-github-event'] as string | undefined,
        }
      );

      console.error('Webhook processing error:', JSON.stringify(structuredError));
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
