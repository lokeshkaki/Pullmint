import { FastifyInstance } from 'fastify';
import { getDb } from '@pullmint/shared/db';
import { sql } from 'drizzle-orm';
import { addTraceAnnotations } from '@pullmint/shared/tracing';

export function registerAnalyticsRoutes(app: FastifyInstance): void {
  // GET /dashboard/analytics/summary
  app.get('/dashboard/analytics/summary', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/summary' });
    try {
      const { dateFrom, dateTo } = request.query as Record<string, string | undefined>;

      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = dateFrom ?? defaultFrom;
      const to = dateTo ?? new Date().toISOString();

      const db = getDb();

      // Main aggregate query — single pass over executions in date range
      const aggregateRows = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                       AS "totalPRsAnalyzed",
          ROUND(AVG(risk_score)::numeric, 1)                                  AS "avgRiskScore",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY risk_score)::numeric   AS "medianRiskScore",
          COUNT(*) FILTER (WHERE risk_score >= 40)::int                       AS "highRiskPRs",
          COUNT(*) FILTER (
            WHERE status = 'completed'
              AND metadata->'checkpoints'->0->>'decision' = 'approved'
          )::int                                                              AS "autoApproved",
          COUNT(*) FILTER (
            WHERE status = 'completed'
              AND metadata->'checkpoints'->0->>'decision' = 'held'
          )::int                                                              AS "held",
          COUNT(*) FILTER (WHERE status = 'rolled-back')::int                AS "rolledBack",
          ROUND(AVG(
            EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000
          )::numeric)::int                                                    AS "avgAnalysisTimeMs"
        FROM executions
        WHERE created_at >= ${from}::timestamptz
          AND created_at <= ${to}::timestamptz
      `);

      // Finding type aggregation — expand JSONB array elements
      // findings column stores an array of finding objects each with a "type" field
      const findingTypeRows = await db.execute(sql`
        SELECT
          finding->>'type' AS type,
          COUNT(*)::int    AS count
        FROM executions,
             jsonb_array_elements(
               CASE WHEN findings IS NOT NULL THEN findings::jsonb ELSE '[]'::jsonb END
             ) AS finding
        WHERE created_at >= ${from}::timestamptz
          AND created_at <= ${to}::timestamptz
          AND findings IS NOT NULL
        GROUP BY finding->>'type'
        ORDER BY count DESC
        LIMIT 10
      `);

      const agg = aggregateRows[0] ?? {};

      return reply.send({
        totalPRsAnalyzed: Number(agg.totalPRsAnalyzed ?? 0),
        avgRiskScore: Number(agg.avgRiskScore ?? 0),
        medianRiskScore: Number(agg.medianRiskScore ?? 0),
        highRiskPRs: Number(agg.highRiskPRs ?? 0),
        autoApproved: Number(agg.autoApproved ?? 0),
        held: Number(agg.held ?? 0),
        rolledBack: Number(agg.rolledBack ?? 0),
        avgAnalysisTimeMs: Number(agg.avgAnalysisTimeMs ?? 0),
        topFindingTypes: Array.from(findingTypeRows).map((r) => {
          const row = r;
          return {
            type: (row.type as string | null | undefined) ?? '',
            count: Number(row.count ?? 0),
          };
        }),
      });
    } catch (error) {
      console.error('Analytics summary error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/analytics/trends
  app.get('/dashboard/analytics/trends', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/trends' });
    try {
      const {
        dateFrom,
        dateTo,
        interval: intervalRaw,
      } = request.query as Record<string, string | undefined>;

      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = dateFrom ?? defaultFrom;
      const to = dateTo ?? new Date().toISOString();

      // Validate interval to prevent SQL injection — only accept known values
      const allowed = ['day', 'week', 'month'] as const;
      type Interval = (typeof allowed)[number];
      const interval: Interval = (allowed as readonly string[]).includes(intervalRaw ?? '')
        ? (intervalRaw as Interval)
        : 'day';

      const db = getDb();

      // Use a CTE to generate the full date series (zero-fill), then left-join actual data.
      // generate_series produces one row per interval bucket regardless of whether executions exist.
      const rows = await db.execute(sql`
        WITH date_series AS (
          SELECT generate_series(
            date_trunc(${interval}, ${from}::timestamptz),
            date_trunc(${interval}, ${to}::timestamptz),
            ('1 ' || ${interval})::interval
          ) AS bucket
        ),
        execution_buckets AS (
          SELECT
            date_trunc(${interval}, created_at) AS bucket,
            ROUND(AVG(risk_score)::numeric, 1)  AS avg_risk,
            COUNT(*)::int                        AS pr_count,
            COUNT(*) FILTER (WHERE status = 'rolled-back')::int AS rollback_count
          FROM executions
          WHERE created_at >= ${from}::timestamptz
            AND created_at <= ${to}::timestamptz
          GROUP BY date_trunc(${interval}, created_at)
        )
        SELECT
          date_series.bucket                           AS date,
          COALESCE(execution_buckets.avg_risk, 0)      AS "avgRisk",
          COALESCE(execution_buckets.pr_count, 0)      AS "prCount",
          COALESCE(execution_buckets.rollback_count, 0) AS "rollbackCount"
        FROM date_series
        LEFT JOIN execution_buckets USING (bucket)
        ORDER BY date_series.bucket ASC
      `);

      return reply.send({
        buckets: Array.from(rows).map((r) => {
          const row = r;
          return {
            date:
              row.date instanceof Date
                ? row.date.toISOString().slice(0, 10)
                : String(row.date).slice(0, 10),
            avgRisk: Number(row.avgRisk ?? 0),
            prCount: Number(row.prCount ?? 0),
            rollbackCount: Number(row.rollbackCount ?? 0),
          };
        }),
      });
    } catch (error) {
      console.error('Analytics trends error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/analytics/authors
  app.get('/dashboard/analytics/authors', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/authors' });
    try {
      const {
        dateFrom,
        dateTo,
        limit: limitRaw,
      } = request.query as Record<string, string | undefined>;

      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = dateFrom ?? defaultFrom;
      const to = dateTo ?? new Date().toISOString();
      const parsedLimit = Math.min(Number.parseInt(limitRaw ?? '20', 10) || 20, 100);

      const db = getDb();

      // Main per-author aggregation
      const authorRows = await db.execute(sql`
        WITH ranked AS (
          SELECT
            author,
            risk_score,
            status,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY author ORDER BY created_at DESC) AS rn
          FROM executions
          WHERE author IS NOT NULL
            AND created_at >= ${from}::timestamptz
            AND created_at <= ${to}::timestamptz
        ),
        recent5 AS (
          SELECT author, AVG(risk_score) AS recent_avg
          FROM ranked
          WHERE rn <= 5
          GROUP BY author
        ),
        prev5 AS (
          SELECT author, AVG(risk_score) AS prev_avg
          FROM ranked
          WHERE rn BETWEEN 6 AND 10
          GROUP BY author
        ),
        base AS (
          SELECT
            author,
            COUNT(*)::int                                                AS pr_count,
            ROUND(AVG(risk_score)::numeric, 1)                          AS avg_risk_score,
            ROUND(
              (COUNT(*) FILTER (WHERE status = 'rolled-back'))::numeric /
              NULLIF(COUNT(*), 0), 3
            )                                                           AS rollback_rate
          FROM executions
          WHERE author IS NOT NULL
            AND created_at >= ${from}::timestamptz
            AND created_at <= ${to}::timestamptz
          GROUP BY author
        )
        SELECT
          base.author        AS login,
          base.pr_count      AS "prCount",
          base.avg_risk_score AS "avgRiskScore",
          COALESCE(base.rollback_rate, 0) AS "rollbackRate",
          recent5.recent_avg AS recent_avg,
          prev5.prev_avg     AS prev_avg
        FROM base
        LEFT JOIN recent5 USING (author)
        LEFT JOIN prev5   USING (author)
        ORDER BY base.pr_count DESC
        LIMIT ${parsedLimit}
      `);

      // Top finding type per author — separate query to avoid cross-join explosion
      const findingsByAuthor = await db.execute(sql`
        SELECT
          author,
          finding->>'type'  AS type,
          COUNT(*)::int     AS cnt
        FROM executions,
             jsonb_array_elements(
               CASE WHEN findings IS NOT NULL THEN findings::jsonb ELSE '[]'::jsonb END
             ) AS finding
        WHERE author IS NOT NULL
          AND findings IS NOT NULL
          AND created_at >= ${from}::timestamptz
          AND created_at <= ${to}::timestamptz
        GROUP BY author, finding->>'type'
      `);

      // Build a map: author -> topFindingType
      const topFindingMap = new Map<string, { type: string; cnt: number }>();
      for (const r of findingsByAuthor) {
        const row = r;
        const author = (row.author as string | null | undefined) ?? '';
        const cnt = Number(row.cnt ?? 0);
        const existing = topFindingMap.get(author);
        if (!existing || cnt > existing.cnt) {
          topFindingMap.set(author, { type: (row.type as string | null | undefined) ?? '', cnt });
        }
      }

      const authors = Array.from(authorRows).map((r) => {
        const row = r;
        const login = (row.login as string | null | undefined) ?? '';
        const recentAvg = row.recent_avg !== null ? Number(row.recent_avg) : null;
        const prevAvg = row.prev_avg !== null ? Number(row.prev_avg) : null;

        let trend: 'improving' | 'stable' | 'declining' = 'stable';
        if (recentAvg !== null && prevAvg !== null && prevAvg > 0) {
          const pctChange = (recentAvg - prevAvg) / prevAvg;
          if (pctChange < -0.1)
            trend = 'improving'; // risk went down >10%
          else if (pctChange > 0.1) trend = 'declining'; // risk went up >10%
        }

        return {
          login,
          prCount: Number(row.prCount ?? 0),
          avgRiskScore: Number(row.avgRiskScore ?? 0),
          rollbackRate: Number(row.rollbackRate ?? 0),
          topFindingType: topFindingMap.get(login)?.type ?? null,
          trend,
        };
      });

      return reply.send({ authors });
    } catch (error) {
      console.error('Analytics authors error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /dashboard/analytics/repos
  app.get('/dashboard/analytics/repos', async (request, reply) => {
    addTraceAnnotations({ path: '/dashboard/analytics/repos' });
    try {
      const { dateFrom, dateTo } = request.query as Record<string, string | undefined>;

      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = dateFrom ?? defaultFrom;
      const to = dateTo ?? new Date().toISOString();

      const db = getDb();

      // Per-repo aggregation with calibration join
      const repoRows = await db.execute(sql`
        SELECT
          e.repo_full_name                                                AS "repoFullName",
          COUNT(*)::int                                                   AS "prCount",
          ROUND(AVG(e.risk_score)::numeric, 1)                           AS "avgRiskScore",
          ROUND(
            (COUNT(*) FILTER (WHERE e.status = 'rolled-back'))::numeric /
            NULLIF(COUNT(*), 0), 3
          )                                                              AS "rollbackRate",
          c.calibration_factor                                           AS "calibrationFactor"
        FROM executions e
        LEFT JOIN calibrations c USING (repo_full_name)
        WHERE e.created_at >= ${from}::timestamptz
          AND e.created_at <= ${to}::timestamptz
        GROUP BY e.repo_full_name, c.calibration_factor
        ORDER BY "prCount" DESC
      `);

      // Top 2 finding types per repo
      const findingTypeRows = await db.execute(sql`
        SELECT
          repo_full_name AS "repoFullName",
          finding->>'type'  AS type,
          COUNT(*)::int     AS cnt
        FROM executions,
             jsonb_array_elements(
               CASE WHEN findings IS NOT NULL THEN findings::jsonb ELSE '[]'::jsonb END
             ) AS finding
        WHERE findings IS NOT NULL
          AND created_at >= ${from}::timestamptz
          AND created_at <= ${to}::timestamptz
        GROUP BY repo_full_name, finding->>'type'
        ORDER BY repo_full_name, cnt DESC
      `);

      // Build map: repoFullName -> top 2 types (already ordered by cnt desc)
      const topTypesMap = new Map<string, string[]>();
      for (const r of findingTypeRows) {
        const row = r;
        const repo = (row.repoFullName as string | null | undefined) ?? '';
        const type = (row.type as string | null | undefined) ?? '';
        const existing = topTypesMap.get(repo) ?? [];
        if (existing.length < 2) {
          existing.push(type);
          topTypesMap.set(repo, existing);
        }
      }

      const repos = Array.from(repoRows).map((r) => {
        const row = r;
        const repoFullName = (row.repoFullName as string | null | undefined) ?? '';
        return {
          repoFullName,
          prCount: Number(row.prCount ?? 0),
          avgRiskScore: Number(row.avgRiskScore ?? 0),
          rollbackRate: Number(row.rollbackRate ?? 0),
          calibrationFactor: row.calibrationFactor !== null ? Number(row.calibrationFactor) : null,
          topFindingTypes: topTypesMap.get(repoFullName) ?? [],
        };
      });

      return reply.send({ repos });
    } catch (error) {
      console.error('Analytics repos error:', error);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
} // end registerAnalyticsRoutes
