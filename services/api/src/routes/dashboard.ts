import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig } from '@pullmint/shared/config';
import { addTraceAnnotations } from '@pullmint/shared/tracing';
import {
  sendNotification,
  validateWebhookUrl,
  type NotificationChannel,
  type NotificationPayload,
} from '@pullmint/shared/notifications';
import { eq, and, desc, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PRExecutionSchema } from '@pullmint/shared/schemas';
import { registerAnalyticsRoutes } from './analytics';
import { timingSafeTokenCompare } from '../auth';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const VALID_CHANNEL_TYPES = ['slack', 'discord', 'teams', 'webhook'] as const;
const VALID_EVENTS = [
  'analysis.completed',
  'analysis.failed',
  'deployment.rolled-back',
  'budget.exceeded',
] as const;

const NotificationChannelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  channelType: z.enum(VALID_CHANNEL_TYPES),
  webhookUrl: z.string().url(),
  repoFilter: z.string().nullable().optional(),
  events: z.array(z.enum(VALID_EVENTS)).min(1),
  minRiskScore: z.number().int().min(0).max(100).nullable().optional(),
  enabled: z.boolean().optional().default(true),
  secret: z.string().nullable().optional(),
});

const NotificationChannelUpdateSchema = NotificationChannelCreateSchema.partial();

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
  if (!timingSafeTokenCompare(token, expected)) {
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

  // GET /dashboard/analytics/costs/budget-status
  app.get('/dashboard/analytics/costs/budget-status', async (_request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/costs/budget-status' });
    const db = getDb();

    try {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const repoUsage = await db
        .select({
          repoFullName: schema.tokenUsage.repoFullName,
          usedUsd: sql<number>`COALESCE(SUM(${schema.tokenUsage.estimatedCostUsd}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${schema.tokenUsage.inputTokens} + ${schema.tokenUsage.outputTokens}), 0)`,
          dayCount: sql<number>`COUNT(DISTINCT DATE(${schema.tokenUsage.createdAt}))`,
        })
        .from(schema.tokenUsage)
        .where(sql`${schema.tokenUsage.createdAt} >= ${monthStart}`)
        .groupBy(schema.tokenUsage.repoFullName)
        .orderBy(desc(sql`SUM(${schema.tokenUsage.estimatedCostUsd})`));

      const repoStatuses = await Promise.all(
        repoUsage.map(async (row) => {
          const usedUsd = Number(row.usedUsd);

          const [latestExec] = await db
            .select({
              metadata: schema.executions.metadata,
            })
            .from(schema.executions)
            .where(
              and(
                eq(schema.executions.repoFullName, row.repoFullName),
                inArray(schema.executions.status, ['completed', 'confirmed'])
              )
            )
            .orderBy(desc(schema.executions.createdAt))
            .limit(1);

          const repoConfig = latestExec?.metadata?.repoConfig as
            | { monthly_budget_usd?: number }
            | undefined;
          const budgetUsd = repoConfig?.monthly_budget_usd ?? null;

          const daysElapsed = Math.max(1, now.getUTCDate());
          const daysInMonth = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
          ).getUTCDate();
          const projectedUsd = (usedUsd / daysElapsed) * daysInMonth;

          return {
            repoFullName: row.repoFullName,
            usedUsd,
            budgetUsd,
            remainingUsd: budgetUsd !== null ? Math.max(0, budgetUsd - usedUsd) : null,
            projectedUsd: Math.round(projectedUsd * 100) / 100,
            totalTokens: Number(row.totalTokens),
            budgetExceeded: budgetUsd !== null ? usedUsd >= budgetUsd : false,
          };
        })
      );

      const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        .toISOString()
        .split('T')[0];

      return reply.status(200).send({
        month: monthStart.toISOString().split('T')[0],
        resetDate,
        repos: repoStatuses,
      });
    } catch (error) {
      console.error('Budget status API error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/analytics/costs
  app.get('/dashboard/analytics/costs', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/costs' });
    const { dateFrom, dateTo, repoFullName } = request.query as Record<string, string | undefined>;

    const db = getDb();

    try {
      const conditions: SQL[] = [];

      if (repoFullName) {
        conditions.push(eq(schema.tokenUsage.repoFullName, repoFullName));
      }
      if (dateFrom) {
        conditions.push(sql`${schema.tokenUsage.createdAt} >= ${dateFrom}`);
      }
      if (dateTo) {
        conditions.push(sql`${schema.tokenUsage.createdAt} <= ${dateTo}`);
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [totals] = await db
        .select({
          totalCostUsd: sql<number>`COALESCE(SUM(${schema.tokenUsage.estimatedCostUsd}), 0)`,
          totalInputTokens: sql<number>`COALESCE(SUM(${schema.tokenUsage.inputTokens}), 0)`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${schema.tokenUsage.outputTokens}), 0)`,
        })
        .from(schema.tokenUsage)
        .where(whereClause);

      const byRepo = await db
        .select({
          repoFullName: schema.tokenUsage.repoFullName,
          costUsd: sql<number>`SUM(${schema.tokenUsage.estimatedCostUsd})`,
          prCount: sql<number>`COUNT(DISTINCT ${schema.tokenUsage.executionId})`,
        })
        .from(schema.tokenUsage)
        .where(whereClause)
        .groupBy(schema.tokenUsage.repoFullName)
        .orderBy(desc(sql`SUM(${schema.tokenUsage.estimatedCostUsd})`));

      const byAgent = await db
        .select({
          agentType: schema.tokenUsage.agentType,
          costUsd: sql<number>`SUM(${schema.tokenUsage.estimatedCostUsd})`,
          callCount: sql<number>`COUNT(*)`,
        })
        .from(schema.tokenUsage)
        .where(whereClause)
        .groupBy(schema.tokenUsage.agentType)
        .orderBy(desc(sql`SUM(${schema.tokenUsage.estimatedCostUsd})`));

      const byModel = await db
        .select({
          model: schema.tokenUsage.model,
          costUsd: sql<number>`SUM(${schema.tokenUsage.estimatedCostUsd})`,
          tokenCount: sql<number>`SUM(${schema.tokenUsage.inputTokens} + ${schema.tokenUsage.outputTokens})`,
        })
        .from(schema.tokenUsage)
        .where(whereClause)
        .groupBy(schema.tokenUsage.model)
        .orderBy(desc(sql`SUM(${schema.tokenUsage.estimatedCostUsd})`));

      const dailyTrend = await db
        .select({
          date: sql<string>`DATE(${schema.tokenUsage.createdAt})::text`,
          costUsd: sql<number>`SUM(${schema.tokenUsage.estimatedCostUsd})`,
          prCount: sql<number>`COUNT(DISTINCT ${schema.tokenUsage.executionId})`,
        })
        .from(schema.tokenUsage)
        .where(whereClause)
        .groupBy(sql`DATE(${schema.tokenUsage.createdAt})`)
        .orderBy(sql`DATE(${schema.tokenUsage.createdAt})`);

      return reply.status(200).send({
        totalCostUsd: Number(totals?.totalCostUsd ?? 0),
        totalInputTokens: Number(totals?.totalInputTokens ?? 0),
        totalOutputTokens: Number(totals?.totalOutputTokens ?? 0),
        byRepo: byRepo.map((row) => ({
          repoFullName: row.repoFullName,
          costUsd: Number(row.costUsd),
          prCount: Number(row.prCount),
        })),
        byAgent: byAgent.map((row) => ({
          agentType: row.agentType,
          costUsd: Number(row.costUsd),
          callCount: Number(row.callCount),
        })),
        byModel: byModel.map((row) => ({
          model: row.model,
          costUsd: Number(row.costUsd),
          tokenCount: Number(row.tokenCount),
        })),
        dailyTrend: dailyTrend.map((row) => ({
          date: row.date,
          costUsd: Number(row.costUsd),
          prCount: Number(row.prCount),
        })),
      });
    } catch (error) {
      console.error('Cost analytics API error:', error);
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

  // GET /dashboard/notifications
  app.get('/dashboard/notifications', async (_request, reply) => {
    const db = getDb();
    const channels = await db
      .select()
      .from(schema.notificationChannels)
      .orderBy(desc(schema.notificationChannels.createdAt));
    await reply.send({ channels });
  });

  // POST /dashboard/notifications
  app.post('/dashboard/notifications', async (request, reply) => {
    const parseResult = NotificationChannelCreateSchema.safeParse(request.body);
    if (!parseResult.success) {
      await reply
        .status(400)
        .send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }

    const data = parseResult.data;
    const validation = await validateWebhookUrl(data.webhookUrl);
    if (!validation.valid) {
      await reply.status(422).send({
        error: 'Invalid webhook URL',
        reason: validation.reason ?? 'URL blocked by security policy',
      });
      return;
    }

    const db = getDb();
    const [created] = await db
      .insert(schema.notificationChannels)
      .values({
        name: data.name,
        channelType: data.channelType,
        webhookUrl: data.webhookUrl,
        repoFilter: data.repoFilter ?? null,
        events: data.events,
        minRiskScore: data.minRiskScore ?? null,
        enabled: data.enabled,
        secret: data.secret ?? null,
      })
      .returning();

    await reply.status(201).send({ channel: created });
  });

  // PUT /dashboard/notifications/:id
  app.put('/dashboard/notifications/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) {
      await reply.status(400).send({ error: 'Invalid channel ID' });
      return;
    }

    const parseResult = NotificationChannelUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      await reply
        .status(400)
        .send({ error: 'Invalid request body', details: parseResult.error.issues });
      return;
    }

    const data = parseResult.data;
    const db = getDb();
    const [updated] = await db
      .update(schema.notificationChannels)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.notificationChannels.id, id))
      .returning();

    if (!updated) {
      await reply.status(404).send({ error: 'Channel not found' });
      return;
    }

    await reply.send({ channel: updated });
  });

  // DELETE /dashboard/notifications/:id
  app.delete('/dashboard/notifications/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) {
      await reply.status(400).send({ error: 'Invalid channel ID' });
      return;
    }

    const db = getDb();
    const [deleted] = await db
      .delete(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, id))
      .returning();

    if (!deleted) {
      await reply.status(404).send({ error: 'Channel not found' });
      return;
    }

    await reply.status(204).send();
  });

  // POST /dashboard/notifications/:id/test
  app.post('/dashboard/notifications/:id/test', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (Number.isNaN(id)) {
      await reply.status(400).send({ error: 'Invalid channel ID' });
      return;
    }

    const db = getDb();
    const [channel] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, id))
      .limit(1);

    if (!channel) {
      await reply.status(404).send({ error: 'Channel not found' });
      return;
    }

    const testPayload: NotificationPayload = {
      event: 'analysis.completed',
      executionId: 'test-execution-id',
      repoFullName: channel.repoFilter ?? 'org/repo',
      prNumber: 42,
      prTitle: 'Test PR - Pullmint notification check',
      author: 'pullmint-bot',
      riskScore: 35,
      findingsCount: 3,
      status: 'completed',
      summary: 'This is a test notification from Pullmint.',
      dashboardUrl: undefined,
      prUrl: 'https://github.com/org/repo/pull/42',
      timestamp: Date.now(),
    };

    await sendNotification(channel as NotificationChannel, testPayload);

    await reply.send({ ok: true, message: 'Test notification sent' });
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

  registerAnalyticsRoutes(app);
}
