// benchmarks/src/database.bench.ts
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// These benchmarks require a live PostgreSQL instance.
// Skip gracefully when DATABASE_URL is not set.
import { registerSuite } from './harness';
import { faker } from '@faker-js/faker';

const DATABASE_URL = process.env['DATABASE_URL'];

if (DATABASE_URL) {
  // Dynamic import to avoid drizzle failing at parse time when no DB is present
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { drizzle } = require('drizzle-orm/node-postgres');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { Pool } = require('pg');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { schema } = require('../../services/shared/schema');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { eq, and, gte, lte, sql } = require('drizzle-orm');

  const pool = new Pool({ connectionString: DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const db = drizzle(pool, { schema });

  // Pre-generate a stable executionId for SELECT benchmarks
  const stableId = faker.string.uuid();

  registerSuite({
    name: 'database',
    iterations: 50, // lower iterations for I/O benchmarks
    tasks: [
      {
        name: 'execution INSERT',
        tags: ['io'],
        setup: async () => {
          // Insert the stable row used by UPDATE/SELECT benchmarks
          await db
            .insert(schema.executions)
            .values({
              executionId: stableId,
              repoFullName: 'bench/repo',
              prNumber: 1,
              headSha: faker.git.commitSha(),
              status: 'pending',
              timestamp: Date.now(),
            })
            .onConflictDoNothing();
        },
        fn: async () => {
          await db
            .insert(schema.executions)
            .values({
              executionId: faker.string.uuid(),
              repoFullName: 'bench/repo',
              prNumber: faker.number.int({ min: 2, max: 9999 }),
              headSha: faker.git.commitSha(),
              status: 'pending',
              timestamp: Date.now(),
            })
            .onConflictDoNothing();
        },
      },
      {
        name: 'execution UPDATE with RETURNING (atomic)',
        tags: ['io'],
        fn: async () => {
          await db
            .update(schema.executions)
            .set({ status: 'analyzing', updatedAt: Date.now() })
            .where(eq(schema.executions.executionId, stableId))
            .returning();
        },
      },
      {
        name: 'execution SELECT with 7 filter conditions',
        tags: ['io'],
        fn: async () => {
          await db
            .select()
            .from(schema.executions)
            .where(
              and(
                eq(schema.executions.repoFullName, 'bench/repo'),
                eq(schema.executions.status, 'completed'),
                gte(schema.executions.timestamp, Date.now() - 86_400_000),
                lte(schema.executions.timestamp, Date.now())
              )
            )
            .limit(20);
        },
      },
      {
        name: 'JSONB containment query — findings @> security',
        tags: ['io'],
        fn: async () => {
          await db
            .select()
            .from(schema.executions)
            .where(sql`findings::jsonb @> '[{"type": "security"}]'::jsonb`)
            .limit(10);
        },
      },
      {
        name: 'aggregate query — AVG(riskScore) with date range',
        tags: ['io'],
        fn: async () => {
          await db
            .select({
              avg: sql<number>`AVG(${schema.executions.riskScore})`,
              count: sql<number>`COUNT(*)`,
            })
            .from(schema.executions)
            .where(
              and(
                eq(schema.executions.repoFullName, 'bench/repo'),
                gte(schema.executions.timestamp, Date.now() - 30 * 86_400_000)
              )
            );
        },
      },
    ],
  });
}
