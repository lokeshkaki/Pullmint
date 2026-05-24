import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@pullmint/shared/db';
import { publishEvent } from '@pullmint/shared/execution-events';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import type { PREvent } from '@pullmint/shared/types';
import { generateExecutionId } from '@pullmint/shared/utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const paramsSchema = z.object({
  owner: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
  number: z.coerce.number().int().positive(),
});
const bodySchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  head: z.object({ sha: z.string().min(1) }),
  base: z.object({
    sha: z.string().min(1),
    repo: z.object({ owner: z.object({ id: z.number() }) }).optional(),
  }),
  user: z.object({ login: z.string().min(1) }),
});

export function registerOperatorRoutes(app: FastifyInstance): void {
  app.post('/dashboard/repos/:owner/:repo/prs/:number/analyze', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'Invalid manual analysis request' });
    }

    const { owner, repo, number: prNumber } = params.data;
    const repoFullName = `${owner}/${repo}`;
    addTraceAnnotations({
      path: '/dashboard/repos/:owner/:repo/prs/:number/analyze',
      repoFullName,
      prNumber,
    });

    let fetched: { data: unknown };
    try {
      const github = await getGitHubInstallationClient(repoFullName);
      fetched = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    } catch {
      return reply.status(404).send({ error: 'Pull request is not accessible' });
    }

    const parsedPR = pullRequestSchema.safeParse(fetched.data);
    if (!parsedPR.success) {
      return reply.status(404).send({ error: 'Pull request is not accessible' });
    }
    const pr = parsedPR.data;
    if (pr.state !== 'open') {
      return reply.status(409).send({ error: 'Only open pull requests can be analyzed' });
    }

    try {
      const db = getDb();
      const dedupKey = `manual-analysis:${repoFullName}:${prNumber}:${pr.head.sha}`;
      const existing = await db
        .select()
        .from(schema.webhookDedup)
        .where(eq(schema.webhookDedup.deliveryId, dedupKey))
        .limit(1);
      if (existing.length > 0) {
        return reply
          .status(429)
          .send({ error: 'Analysis recently requested. Try again in 2 minutes.' });
      }
      await db.insert(schema.webhookDedup).values({
        deliveryId: dedupKey,
        expiresAt: new Date(Date.now() + 120 * 1000),
      });

      const executionId = `${generateExecutionId(repoFullName, prNumber, pr.head.sha)}-manual-${randomUUID()}`;
      const metadata = {
        trigger: 'manual',
        source: 'operator-api',
        ...(body.data.reason && { reason: body.data.reason }),
      };
      const prEvent: PREvent = {
        prNumber,
        repoFullName,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        author: pr.user.login,
        title: pr.title,
        orgId: pr.base.repo?.owner.id ? `org_${pr.base.repo.owner.id}` : `org_${owner}`,
      };
      await db.insert(schema.executions).values({
        executionId,
        repoFullName,
        prNumber,
        headSha: prEvent.headSha,
        baseSha: prEvent.baseSha,
        author: prEvent.author,
        title: prEvent.title,
        orgId: prEvent.orgId,
        status: 'pending',
        metadata,
      });

      try {
        await addJob(QUEUE_NAMES.ANALYSIS, 'pr.manual', { ...prEvent, executionId });
      } catch {
        await db
          .update(schema.executions)
          .set({
            status: 'failed',
            metadata: { ...metadata, failureCategory: 'queue_submission_failed' },
            updatedAt: new Date(),
          })
          .where(eq(schema.executions.executionId, executionId));
        void publishEvent({
          executionId,
          repoFullName,
          prNumber,
          status: 'failed',
          riskScore: null,
          updatedAt: Date.now(),
        });
        return reply.status(500).send({ error: 'Manual analysis could not be queued' });
      }

      addTraceAnnotations({ executionId });
      return reply.status(202).send({
        message: 'Analysis queued',
        executionId,
        repoFullName,
        prNumber,
        headSha: prEvent.headSha,
        status: 'pending',
        costIncurred: true,
      });
    } catch (error) {
      request.log.error({ err: error, repoFullName, prNumber }, 'Manual analysis request failed');
      return reply.status(500).send({ error: 'Manual analysis request failed' });
    }
  });
}
