import { lt } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';

export async function processCleanupJob(): Promise<void> {
  const db = getDb();
  const now = new Date();

  // Remove expired webhook dedup entries
  const dedupResult = await db
    .delete(schema.webhookDedup)
    .where(lt(schema.webhookDedup.expiresAt, now))
    .returning({ deliveryId: schema.webhookDedup.deliveryId });

  // Remove expired LLM rate limit buckets
  const rateLimitResult = await db
    .delete(schema.llmRateLimits)
    .where(lt(schema.llmRateLimits.expiresAt, now))
    .returning({ id: schema.llmRateLimits.id });

  // Remove expired LLM cache entries
  const cacheResult = await db
    .delete(schema.llmCache)
    .where(lt(schema.llmCache.expiresAt, now))
    .returning({ cacheKey: schema.llmCache.cacheKey });

  // Remove expired dependency graph edges
  const depResult = await db
    .delete(schema.dependencyGraphs)
    .where(lt(schema.dependencyGraphs.expiresAt, now))
    .returning({ id: schema.dependencyGraphs.id });

  console.info('[cleanup] Completed', {
    webhookDedupDeleted: dedupResult.length,
    rateLimitsDeleted: rateLimitResult.length,
    cacheEntriesDeleted: cacheResult.length,
    dependencyEdgesDeleted: depResult.length,
  });
}
