import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from './db';

// Pricing in USD per 1 million tokens.
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
  'gemini-1.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
};

const FALLBACK_PRICING = { inputPer1M: 1.0, outputPer1M: 5.0 };

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

export interface RecordTokenUsageParams {
  executionId: string | null;
  repoFullName: string;
  agentType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

type DrizzleDb = ReturnType<typeof getDb>;

export async function recordTokenUsage(
  db: DrizzleDb,
  params: RecordTokenUsageParams
): Promise<void> {
  const { executionId, repoFullName, agentType, model, inputTokens, outputTokens } = params;
  const estimatedCostUsd = estimateCost(model, inputTokens, outputTokens);

  try {
    await db.insert(schema.tokenUsage).values({
      executionId,
      repoFullName,
      agentType,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    });
  } catch (error) {
    // Best-effort telemetry: usage recording should never block job processing.
    console.error('[cost-tracker] Failed to record token usage:', {
      executionId,
      agentType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface UsageSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

export async function getUsageSummary(
  db: DrizzleDb,
  repoFullName: string,
  dateFrom: Date,
  dateTo: Date
): Promise<UsageSummary> {
  const rows = await db
    .select({
      totalCostUsd: sql<number>`COALESCE(SUM(${schema.tokenUsage.estimatedCostUsd}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${schema.tokenUsage.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${schema.tokenUsage.outputTokens}), 0)`,
      callCount: sql<number>`COUNT(*)`,
    })
    .from(schema.tokenUsage)
    .where(
      and(
        eq(schema.tokenUsage.repoFullName, repoFullName),
        sql`${schema.tokenUsage.createdAt} >= ${dateFrom}`,
        sql`${schema.tokenUsage.createdAt} <= ${dateTo}`
      )
    );

  const row = rows[0];
  return {
    totalCostUsd: Number(row?.totalCostUsd ?? 0),
    totalInputTokens: Number(row?.totalInputTokens ?? 0),
    totalOutputTokens: Number(row?.totalOutputTokens ?? 0),
    callCount: Number(row?.callCount ?? 0),
  };
}

export interface BudgetStatus {
  allowed: boolean;
  usedUsd: number;
  budgetUsd: number;
  remainingUsd: number;
}

export async function checkBudget(
  db: DrizzleDb,
  repoFullName: string,
  budgetUsd: number
): Promise<BudgetStatus> {
  if (!budgetUsd || budgetUsd <= 0) {
    return { allowed: true, usedUsd: 0, budgetUsd: 0, remainingUsd: 0 };
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const summary = await getUsageSummary(db, repoFullName, monthStart, now);
  const usedUsd = summary.totalCostUsd;
  const remainingUsd = Math.max(0, budgetUsd - usedUsd);
  const allowed = usedUsd < budgetUsd;

  return { allowed, usedUsd, budgetUsd, remainingUsd };
}
