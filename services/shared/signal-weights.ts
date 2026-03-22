import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import type { SignalWeights } from './types';

/**
 * Hardcoded defaults matching the current risk delta magnitudes in risk-evaluator.ts.
 * Each value is the risk delta applied when that signal's threshold condition is met.
 */
export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  'ci.result': 15,
  'ci.coverage': 10,
  'production.error_rate': 20,
  'production.latency': 10,
  time_of_day: 5,
  author_history: 10,
  simultaneous_deploy: 8,
  'deployment.status': 0,
};

type DrizzleDb = ReturnType<typeof getDb>;

/**
 * Resolves signal weights for a repository using per-signal fallback:
 * 1. Repo-level weight (if repo has ≥10 observations and weight exists)
 * 2. Global baseline weight (from signal_weight_defaults table)
 * 3. Hardcoded default
 */
export async function resolveSignalWeights(
  repoFullName: string,
  db: DrizzleDb
): Promise<SignalWeights> {
  // Start with hardcoded defaults
  const resolved: SignalWeights = { ...DEFAULT_SIGNAL_WEIGHTS };

  // Load global baseline
  const [globalRow] = await db
    .select({
      weights: schema.signalWeightDefaults.weights,
    })
    .from(schema.signalWeightDefaults)
    .where(eq(schema.signalWeightDefaults.id, 'global'))
    .limit(1);

  if (globalRow?.weights) {
    const globalWeights = globalRow.weights;
    for (const [signal, weight] of Object.entries(globalWeights)) {
      resolved[signal] = weight;
    }
  }

  // Load repo-specific weights (only used if repo has ≥10 observations)
  const [calRecord] = await db
    .select({
      signalWeights: schema.calibrations.signalWeights,
      observationsCount: schema.calibrations.observationsCount,
    })
    .from(schema.calibrations)
    .where(eq(schema.calibrations.repoFullName, repoFullName))
    .limit(1);

  if (calRecord && calRecord.observationsCount >= 10 && calRecord.signalWeights) {
    const repoWeights = calRecord.signalWeights;
    for (const [signal, weight] of Object.entries(repoWeights)) {
      resolved[signal] = weight;
    }
  }

  return resolved;
}
