import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig } from '@pullmint/shared/config';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import { eq, and, desc, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PRExecutionSchema } from '@pullmint/shared/schemas';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TERMINAL_STATUSES = ['completed', 'failed', 'confirmed', 'rolled-back'] as const;

function isTerminalStatus(status: string): status is (typeof TERMINAL_STATUSES)[number] {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

const ExecutionListRecordSchema = z
  .object({
    executionId: z.string(),
    timestamp: z.number().optional(),
  })
  .passthrough();
type ExecutionListRecord = z.infer<typeof ExecutionListRecordSchema>;

const ExecutionCheckpointsViewSchema = z
  .object({
    executionId: z.string(),
    checkpoints: z.array(z.unknown()).optional(),
    signalsReceived: z.record(z.string(), z.unknown()).optional(),
    repoContext: z.record(z.string(), z.unknown()).optional(),
    calibrationApplied: z.number().optional(),
  })
  .passthrough();

function parseExecutionRecord(item: unknown): ExecutionListRecord | null {
  const parsed = PRExecutionSchema.safeParse(item);
  if (parsed.success) {
    return parsed.data;
  }

  const fallbackParsed = ExecutionListRecordSchema.safeParse(item);
  if (fallbackParsed.success) {
    return fallbackParsed.data;
  }

  const executionId =
    item && typeof item === 'object' && 'executionId' in item
      ? (item as { executionId?: unknown }).executionId
      : undefined;
  console.warn('[dashboard-api] Skipping invalid execution record', {
    executionId,
    errors: parsed.error.issues,
  });
  return null;
}

function parseExecutionList(items: unknown[]): ExecutionListRecord[] {
  return items
    .map((item) => parseExecutionRecord(item))
    .filter((execution): execution is ExecutionListRecord => execution !== null);
}

async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
  const token = authHeader.slice(7);
  let expected: string;
  try {
    expected = getConfig('DASHBOARD_AUTH_TOKEN');
  } catch {
    console.error('DASHBOARD_AUTH_TOKEN not configured; denying all requests');
    await reply.status(503).send({ error: 'Service unavailable: authentication not configured' });
    return;
  }
  if (token !== expected) {
    await reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  // Apply auth to all dashboard routes
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/dashboard/') || request.url === '/dashboard') {
      await authMiddleware(request, reply);
    }
  });

  // GET /dashboard/executions
  app.get('/dashboard/executions', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/executions' });
    try {
      const {
        limit: limitRaw = `${DEFAULT_LIMIT}`,
        offset: offsetRaw = '0',
        repo,
        status,
        search,
        dateFrom,
        dateTo,
        author,
        riskMin,
        riskMax,
        findingType,
      } = request.query as Record<string, string | undefined>;

      const parsedLimit = Number.parseInt(limitRaw, 10);
      const parsedOffset = Number.parseInt(offsetRaw, 10);
      const limit = Math.min(Number.isNaN(parsedLimit) ? DEFAULT_LIMIT : parsedLimit, MAX_LIMIT);
      const offset = Number.isNaN(parsedOffset) ? 0 : parsedOffset;

      const conditions: SQL[] = [];

      if (repo) {
        conditions.push(eq(schema.executions.repoFullName, repo));
      }
      if (status) {
        conditions.push(eq(schema.executions.status, status));
      }
      if (search) {
        const searchTerm = search.trim();
        if (searchTerm) {
          if (/^\d+$/.test(searchTerm)) {
            conditions.push(eq(schema.executions.prNumber, Number.parseInt(searchTerm, 10)));
          } else {
            conditions.push(sql`${schema.executions.repoFullName} ILIKE ${`%${searchTerm}%`}`);
          }
        }
      }
      if (dateFrom) {
        conditions.push(sql`${schema.executions.createdAt} >= ${dateFrom}`);
      }
      if (dateTo) {
        conditions.push(sql`${schema.executions.createdAt} <= ${dateTo}`);
      }
      if (author) {
        conditions.push(sql`${schema.executions.author} ILIKE ${`%${author}%`}`);
      }
      if (riskMin !== undefined) {
        const parsedRiskMin = Number(riskMin);
        if (!Number.isNaN(parsedRiskMin)) {
          conditions.push(sql`${schema.executions.riskScore} >= ${parsedRiskMin}`);
        }
      }
      if (riskMax !== undefined) {
        const parsedRiskMax = Number(riskMax);
        if (!Number.isNaN(parsedRiskMax)) {
          conditions.push(sql`${schema.executions.riskScore} <= ${parsedRiskMax}`);
        }
      }
      if (findingType) {
        conditions.push(
          sql`${schema.executions.findings}::jsonb @> ${JSON.stringify([{ type: findingType }])}::jsonb`
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const db = getDb();
      const executions = await db
        .select()
        .from(schema.executions)
        .where(whereClause)
        .orderBy(desc(schema.executions.createdAt))
        .limit(limit)
        .offset(offset);

      const parsed = parseExecutionList(executions);
      return reply.status(200).send({
        executions: parsed,
        count: parsed.length,
        limit,
        offset,
      });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/stats/:owner/:repo
  app.get<{
    Params: { owner: string; repo: string };
  }>('/dashboard/stats/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params;
    const repoFullName = `${owner}/${repo}`;
    addTraceAnnotations({ path: '/dashboard/stats/:owner/:repo', repoFullName });

    try {
      const db = getDb();

      const trendRows = await db
        .select({
          prNumber: schema.executions.prNumber,
          riskScore: schema.executions.riskScore,
          createdAt: schema.executions.createdAt,
        })
        .from(schema.executions)
        .where(
          and(
            eq(schema.executions.repoFullName, repoFullName),
            inArray(schema.executions.status, ['confirmed', 'rolled-back', 'completed']),
            sql`${schema.executions.riskScore} IS NOT NULL`
          )
        )
        .orderBy(desc(schema.executions.createdAt))
        .limit(30);

      trendRows.reverse();

      const summaryRows = await db
        .select({
          total: sql<number>`COUNT(*)`,
          avgRisk: sql<number>`AVG(${schema.executions.riskScore})`,
          confirmedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.executions.status} = 'confirmed')`,
          rolledBackCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.executions.status} = 'rolled-back')`,
        })
        .from(schema.executions)
        .where(
          and(
            eq(schema.executions.repoFullName, repoFullName),
            sql`${schema.executions.riskScore} IS NOT NULL`
          )
        );

      const summary = summaryRows[0];
      const total = Number(summary?.total ?? 0);
      const confirmed = Number(summary?.confirmedCount ?? 0);
      const rolledBack = Number(summary?.rolledBackCount ?? 0);

      return reply.send({
        repoFullName,
        trends: {
          riskScores: trendRows.map((row) => ({
            prNumber: row.prNumber,
            riskScore: row.riskScore,
            createdAt: row.createdAt,
          })),
        },
        summary: {
          totalExecutions: total,
          avgRiskScore: Math.round(Number(summary?.avgRisk ?? 0)),
          successRate:
            confirmed + rolledBack > 0
              ? Math.round((confirmed / (confirmed + rolledBack)) * 100)
              : 0,
        },
      });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/executions/:executionId/rerun-history (must be before /:executionId)
  app.get('/dashboard/executions/:executionId/rerun-history', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    addTraceAnnotations({ path: '/dashboard/executions/:executionId/rerun-history', executionId });

    try {
      const db = getDb();
      const targetRows = await db
        .select()
        .from(schema.executions)
        .where(eq(schema.executions.executionId, executionId))
        .limit(1);
      const target = targetRows[0];

      if (!target) {
        return reply.status(404).send({ error: 'Execution not found' });
      }

      let rootId = executionId;
      let current = target;
      let hops = 0;

      while (hops < 20) {
        const parentId = current.metadata?.rerunOf;
        if (typeof parentId !== 'string') {
          break;
        }

        const parentRows = await db
          .select()
          .from(schema.executions)
          .where(eq(schema.executions.executionId, parentId))
          .limit(1);
        const parent = parentRows[0];

        if (!parent) {
          break;
        }

        current = parent;
        rootId = parentId;
        hops++;
      }

      const rootRows =
        rootId === executionId
          ? [target]
          : await db
              .select()
              .from(schema.executions)
              .where(eq(schema.executions.executionId, rootId))
              .limit(1);
      const root = rootRows[0];

      if (!root) {
        return reply.status(404).send({ error: 'Execution not found' });
      }

      const children = await db
        .select()
        .from(schema.executions)
        .where(sql`${schema.executions.metadata}->>'rerunOf' = ${rootId}`)
        .orderBy(schema.executions.createdAt);

      const chain = [root, ...children].map((exec, idx, entries) => {
        const previous = idx > 0 ? entries[idx - 1] : null;
        const riskScoreDelta =
          exec.riskScore != null && previous?.riskScore != null
            ? Math.round((exec.riskScore - previous.riskScore) * 10) / 10
            : null;

        return {
          executionId: exec.executionId,
          status: exec.status,
          riskScore: exec.riskScore,
          createdAt: exec.createdAt,
          isCurrentExecution: exec.executionId === executionId,
          rerunOf: exec.metadata?.rerunOf ?? null,
          riskScoreDelta,
        };
      });

      return reply.status(200).send({ chain, rootExecutionId: rootId });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/executions/:executionId/checkpoints (must be before /:executionId)
  app.get('/dashboard/executions/:executionId/checkpoints', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    addTraceAnnotations({ path: '/dashboard/executions/:executionId/checkpoints', executionId });
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.executions)
        .where(eq(schema.executions.executionId, executionId))
        .limit(1);
      const raw = rows[0];
      if (!raw) {
        return reply.status(404).send({ error: 'Execution not found' });
      }
      const execution = ExecutionCheckpointsViewSchema.parse(raw);
      return reply.status(200).send({
        executionId,
        checkpoints: execution.checkpoints ?? [],
        signalsReceived: execution.signalsReceived ?? {},
        repoContext: execution.repoContext ?? null,
        calibrationApplied: execution.calibrationApplied ?? null,
      });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /dashboard/executions/:executionId/re-evaluate
  app.post('/dashboard/executions/:executionId/re-evaluate', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    addTraceAnnotations({ path: '/dashboard/executions/:executionId/re-evaluate', executionId });
    try {
      const db = getDb();
      const dedupKey = `reeval:${executionId}`;

      // Rate-limit check (TTL 2 minutes)
      const existing = await db
        .select()
        .from(schema.webhookDedup)
        .where(eq(schema.webhookDedup.deliveryId, dedupKey))
        .limit(1);

      if (existing.length > 0) {
        return reply.status(429).send({ error: 'Rate limit exceeded. Try again in 2 minutes.' });
      }

      // Write rate-limit record (expires in 2 minutes)
      await db.insert(schema.webhookDedup).values({
        deliveryId: dedupKey,
        expiresAt: new Date(Date.now() + 120 * 1000),
      });

      // Parse justification from body (optional)
      let justification = '';
      if (request.body) {
        try {
          const parsed = request.body as Record<string, unknown>;
          if (typeof parsed.justification === 'string') {
            justification = parsed.justification;
          }
        } catch {
          // Ignore parse errors — justification is optional
        }
      }

      // Append to overrideHistory using raw SQL JSONB operation
      const overrideEntry = { overriddenAt: Date.now(), justification };
      await db.execute(
        sql`UPDATE executions
              SET override_history = COALESCE(override_history, '[]'::jsonb) || ${JSON.stringify([overrideEntry])}::jsonb,
                  updated_at = NOW()
              WHERE execution_id = ${executionId}`
      );

      // TODO: publish re-evaluation event when on-demand checkpoint mechanism is defined

      return reply.status(202).send({ message: 'Re-evaluation logged' });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /dashboard/executions/:executionId/rerun
  app.post('/dashboard/executions/:executionId/rerun', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    addTraceAnnotations({ path: '/dashboard/executions/:executionId/rerun', executionId });

    try {
      const db = getDb();

      const rows = await db
        .select()
        .from(schema.executions)
        .where(eq(schema.executions.executionId, executionId))
        .limit(1);
      const original = rows[0];

      if (!original) {
        return reply.status(404).send({ error: 'Execution not found' });
      }

      if (!isTerminalStatus(original.status)) {
        return reply.status(409).send({
          error:
            'Execution is not in a terminal state. Re-run is only allowed after analysis completes.',
          currentStatus: original.status,
        });
      }

      const dedupKey = `rerun:${executionId}`;
      const existing = await db
        .select()
        .from(schema.webhookDedup)
        .where(eq(schema.webhookDedup.deliveryId, dedupKey))
        .limit(1);

      if (existing.length > 0) {
        return reply.status(429).send({
          error: 'Rate limit: wait 1 minute before re-running this execution again.',
        });
      }

      await db.insert(schema.webhookDedup).values({
        deliveryId: dedupKey,
        expiresAt: new Date(Date.now() + 60 * 1000),
      });

      const newExecutionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(schema.executions).values({
        executionId: newExecutionId,
        repoFullName: original.repoFullName,
        prNumber: original.prNumber,
        headSha: original.headSha,
        baseSha: original.baseSha ?? undefined,
        author: original.author ?? undefined,
        title: original.title ?? undefined,
        orgId: original.orgId ?? undefined,
        status: 'pending',
        metadata: { rerunOf: executionId },
      });

      await addJob(QUEUE_NAMES.ANALYSIS, 'pr.opened', {
        executionId: newExecutionId,
        prNumber: original.prNumber,
        repoFullName: original.repoFullName,
        headSha: original.headSha,
        baseSha: original.baseSha ?? '',
        author: original.author ?? 'unknown',
        title: original.title ?? '',
        orgId: original.orgId ?? '',
      });

      console.log(`Re-run triggered: ${executionId} -> ${newExecutionId}`);
      return reply.status(202).send({ executionId: newExecutionId, status: 'pending' });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /dashboard/repos/:owner/:repo/prs/:number/rerun
  app.post<{
    Params: { owner: string; repo: string; number: string };
  }>('/dashboard/repos/:owner/:repo/prs/:number/rerun', async (request, reply) => {
    const { owner, repo, number } = request.params;
    const repoFullName = `${owner}/${repo}`;
    const prNumber = parseInt(number, 10);
    addTraceAnnotations({
      path: '/dashboard/repos/:owner/:repo/prs/:number/rerun',
      repoFullName,
      prNumber,
    });

    if (Number.isNaN(prNumber) || prNumber <= 0) {
      return reply.status(400).send({ error: 'Invalid PR number' });
    }

    try {
      const db = getDb();

      const latestRows = await db
        .select()
        .from(schema.executions)
        .where(
          and(
            eq(schema.executions.repoFullName, repoFullName),
            eq(schema.executions.prNumber, prNumber)
          )
        )
        .orderBy(desc(schema.executions.createdAt))
        .limit(1);
      const latest = latestRows[0];

      if (!latest) {
        return reply.status(404).send({ error: 'No prior analysis found for this PR' });
      }

      const dedupKey = `rerun-latest:${repoFullName}:${prNumber}`;
      const existing = await db
        .select()
        .from(schema.webhookDedup)
        .where(eq(schema.webhookDedup.deliveryId, dedupKey))
        .limit(1);

      if (existing.length > 0) {
        return reply.status(429).send({
          error: 'Rate limit: wait 1 minute before re-running this PR again.',
        });
      }

      await db.insert(schema.webhookDedup).values({
        deliveryId: dedupKey,
        expiresAt: new Date(Date.now() + 60 * 1000),
      });

      let currentHeadSha: string;
      let currentBaseSha: string;
      let prAuthor: string;
      let prTitle: string;

      try {
        const octokit = await getGitHubInstallationClient(repoFullName);
        const prData = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });
        const pr = prData.data as {
          head: { sha: string };
          base: { sha: string };
          user: { login: string };
          title: string;
        };

        currentHeadSha = pr.head.sha;
        currentBaseSha = pr.base.sha;
        prAuthor = pr.user.login;
        prTitle = pr.title;
      } catch (githubError) {
        console.error('Failed to fetch PR from GitHub:', githubError);
        return reply.status(502).send({ error: 'Failed to fetch current PR state from GitHub' });
      }

      const newExecutionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.insert(schema.executions).values({
        executionId: newExecutionId,
        repoFullName,
        prNumber,
        headSha: currentHeadSha,
        baseSha: currentBaseSha,
        author: prAuthor,
        title: prTitle,
        orgId: latest.orgId ?? undefined,
        status: 'pending',
        metadata: {
          rerunOf: latest.executionId,
          rerunType: 'latest-head',
          requestedHeadSha: currentHeadSha,
        },
      });

      await addJob(QUEUE_NAMES.ANALYSIS, 'pr.opened', {
        executionId: newExecutionId,
        prNumber,
        repoFullName,
        headSha: currentHeadSha,
        baseSha: currentBaseSha,
        author: prAuthor,
        title: prTitle,
        orgId: latest.orgId ?? '',
      });

      console.log(
        `Re-run (latest HEAD) triggered for ${repoFullName}#${prNumber}: ${newExecutionId}`
      );
      return reply.status(202).send({
        executionId: newExecutionId,
        status: 'pending',
        headSha: currentHeadSha,
      });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/executions/:executionId
  app.get('/dashboard/executions/:executionId', async (request, reply) => {
    const { executionId } = request.params as { executionId: string };
    addTraceAnnotations({ path: '/dashboard/executions/:executionId', executionId });
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.executions)
        .where(eq(schema.executions.executionId, executionId))
        .limit(1);
      const execution = rows[0];
      if (!execution) {
        return reply.status(404).send({ error: 'Execution not found' });
      }
      return reply.status(200).send(execution);
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/board
  app.get('/dashboard/board', async (_request, reply) => {
    addTraceAnnotations({ path: '/dashboard/board' });
    try {
      const db = getDb();
      const activeStatuses = ['analyzing', 'completed', 'deploying', 'monitoring'];
      const recentTerminalStatuses = ['confirmed', 'rolled-back'];
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const allStatuses = [...activeStatuses, ...recentTerminalStatuses];

      const activeQueries = activeStatuses.map((status) =>
        db.select().from(schema.executions).where(eq(schema.executions.status, status))
      );

      const terminalQueries = recentTerminalStatuses.map((status) =>
        db
          .select()
          .from(schema.executions)
          .where(
            and(
              eq(schema.executions.status, status),
              sql`${schema.executions.deploymentStartedAt} >= ${since24h.toISOString()}`
            )
          )
      );

      const results = await Promise.all([...activeQueries, ...terminalQueries]);
      const board: Record<
        string,
        {
          executionId: string;
          repoFullName: string;
          prNumber: number;
          title?: string | null;
          author?: string | null;
          riskScore?: number | null;
          confidenceScore?: number | null;
          currentCheckpoint?: string;
          deploymentStartedAt?: string | null;
          timeInCurrentStateMs?: number;
        }[]
      > = {};

      results.forEach((result, i) => {
        const status = allStatuses[i];
        board[status] = result
          .map((item) => {
            const parsed = PRExecutionSchema.safeParse(item);
            if (!parsed.success) {
              const execId =
                item && typeof item === 'object' && 'executionId' in item
                  ? String((item as { executionId?: unknown }).executionId)
                  : undefined;
              console.warn('[dashboard-api] Skipping invalid board record', {
                executionId: execId,
                errors: parsed.error.issues,
              });
              return null;
            }
            const exec = parsed.data;
            const lastCheckpoint = exec.checkpoints?.at(-1);
            return {
              executionId: exec.executionId,
              repoFullName: exec.repoFullName,
              prNumber: exec.prNumber,
              title: exec.title,
              author: exec.author,
              riskScore: exec.riskScore,
              confidenceScore: exec.confidenceScore,
              currentCheckpoint: lastCheckpoint?.type,
              deploymentStartedAt:
                exec.deploymentStartedAt != null ? String(exec.deploymentStartedAt) : undefined,
              timeInCurrentStateMs:
                exec.deploymentStartedAt != null
                  ? Date.now() - Number(exec.deploymentStartedAt)
                  : undefined,
            };
          })
          .filter((card): card is NonNullable<typeof card> => card !== null);
      });

      return reply.status(200).send({ board });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/calibration
  app.get('/dashboard/calibration', async (_request, reply) => {
    addTraceAnnotations({ path: '/dashboard/calibration' });
    try {
      const db = getDb();
      const repos = await db.select().from(schema.calibrations);
      repos.sort((a, b) => (b.calibrationFactor ?? 1) - (a.calibrationFactor ?? 1));
      return reply.status(200).send({ repos });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/calibration/:owner/:repo
  app.get('/dashboard/calibration/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params as { owner: string; repo: string };
    const repoFullName = `${owner}/${repo}`;
    addTraceAnnotations({ path: '/dashboard/calibration/:owner/:repo' });
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.calibrations)
        .where(eq(schema.calibrations.repoFullName, repoFullName))
        .limit(1);
      const item = rows[0];
      if (!item) {
        return reply.status(404).send({ error: 'Calibration record not found' });
      }
      return reply.status(200).send(item);
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /dashboard/repos/:owner/:repo/reindex
  app.post('/dashboard/repos/:owner/:repo/reindex', async (request, reply) => {
    const { owner, repo } = request.params as { owner: string; repo: string };
    const repoFullName = `${owner}/${repo}`;
    addTraceAnnotations({ path: '/dashboard/repos/:owner/:repo/reindex' });
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.repoRegistry)
        .where(eq(schema.repoRegistry.repoFullName, repoFullName))
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        return reply.status(404).send({ error: 'Repo not registered' });
      }
      await db
        .update(schema.repoRegistry)
        .set({ indexingStatus: 'pending', pendingBatches: 0 })
        .where(eq(schema.repoRegistry.repoFullName, repoFullName));
      await addJob(QUEUE_NAMES.REPO_INDEXING, 'repo.onboarding.requested', { repoFullName });
      return reply.status(202).send({ message: 'Reindex triggered', repoFullName });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/repos/:owner/:repo
  app.get('/dashboard/repos/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params as { owner: string; repo: string };
    const repoFullName = `${owner}/${repo}`;
    addTraceAnnotations({ path: '/dashboard/repos/:owner/:repo' });
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(schema.repoRegistry)
        .where(eq(schema.repoRegistry.repoFullName, repoFullName))
        .limit(1);
      const item = rows[0];
      if (!item) {
        return reply.status(404).send({ error: 'Repo not registered' });
      }
      return reply.status(200).send(item);
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/repos/:owner/:repo/prs/:number
  app.get('/dashboard/repos/:owner/:repo/prs/:number', async (request, reply) => {
    const { owner, repo, number } = request.params as {
      owner: string;
      repo: string;
      number: string;
    };
    const repoFullName = `${owner}/${repo}`;
    const prNumber = parseInt(number, 10);
    addTraceAnnotations({ path: '/dashboard/repos/:owner/:repo/prs/:number' });
    try {
      const query = request.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(query.limit || `${DEFAULT_LIMIT}`, 10), MAX_LIMIT);
      const offset = parseInt(query.offset || '0', 10);

      const db = getDb();
      const executions = await db
        .select()
        .from(schema.executions)
        .where(
          and(
            eq(schema.executions.repoFullName, repoFullName),
            eq(schema.executions.prNumber, prNumber)
          )
        )
        .orderBy(desc(schema.executions.createdAt))
        .limit(limit)
        .offset(offset);

      const parsed = parseExecutionList(executions);
      return reply.status(200).send({
        executions: parsed,
        count: parsed.length,
        limit,
        offset,
      });
    } catch (error) {
      console.error('Dashboard API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
