import { eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { DEFAULT_SIGNAL_WEIGHTS } from '@pullmint/shared/signal-weights';
import type { OutcomeLogEntry, SignalWeights } from '@pullmint/shared/types';

const MIN_OUTCOME_LOG_SIZE = 10;
const MAX_OUTCOME_LOG_ENTRIES = 200;

export async function processSignalRecalibration(): Promise<void> {
  const db = getDb();

  // Load all repos with outcome logs
  const repos = await db
    .select({
      repoFullName: schema.calibrations.repoFullName,
      outcomeLog: schema.calibrations.outcomeLog,
    })
    .from(schema.calibrations)
    .where(isNotNull(schema.calibrations.outcomeLog));

  // Aggregate all outcome logs for global baseline recomputation
  const allOutcomes: OutcomeLogEntry[] = [];
  let processedRepos = 0;

  for (const repo of repos) {
    const outcomeLog = repo.outcomeLog ?? [];
    if (outcomeLog.length < MIN_OUTCOME_LOG_SIZE) {
      continue;
    }

    processedRepos += 1;
    allOutcomes.push(...outcomeLog);

    // Recompute per-repo signal weights from outcome history
    const recomputedWeights = computeWeightsFromOutcomes(outcomeLog);

    // Trim outcome log and update repo
    const trimmedLog = outcomeLog.slice(-MAX_OUTCOME_LOG_ENTRIES);

    await db
      .update(schema.calibrations)
      .set({
        signalWeights: recomputedWeights,
        outcomeLog: trimmedLog,
        updatedAt: new Date(),
      })
      .where(eq(schema.calibrations.repoFullName, repo.repoFullName));
  }

  // Recompute global baseline from aggregate of all outcome logs
  if (allOutcomes.length >= MIN_OUTCOME_LOG_SIZE) {
    const globalWeights = computeWeightsFromOutcomes(allOutcomes);

    await db
      .insert(schema.signalWeightDefaults)
      .values({
        id: 'global',
        weights: globalWeights,
        observationsCount: allOutcomes.length,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.signalWeightDefaults.id,
        set: {
          weights: globalWeights,
          observationsCount: allOutcomes.length,
          updatedAt: new Date(),
        },
      });
  }

  console.log(
    `Signal recalibration complete: processed ${processedRepos} repos, ${allOutcomes.length} total outcomes`
  );
}

function computeWeightsFromOutcomes(outcomes: OutcomeLogEntry[]): SignalWeights {
  const weights: SignalWeights = {};

  // Get all unique signal types seen in outcomes
  const allSignalTypes = new Set<string>();
  for (const outcome of outcomes) {
    for (const signal of outcome.signalsPresent) {
      allSignalTypes.add(signal);
    }
  }

  for (const signal of allSignalTypes) {
    // Outcomes where this signal was present
    const presentOutcomes = outcomes.filter((o) => o.signalsPresent.includes(signal));
    // Outcomes where this signal was absent
    const absentOutcomes = outcomes.filter((o) => !o.signalsPresent.includes(signal));

    if (presentOutcomes.length === 0) {
      continue;
    }

    const rollbackRateWhenPresent =
      presentOutcomes.filter((o) => o.rollback).length / presentOutcomes.length;
    const rollbackRateWhenAbsent =
      absentOutcomes.length > 0
        ? absentOutcomes.filter((o) => o.rollback).length / absentOutcomes.length
        : 0;

    // How much more likely is rollback when this signal fires?
    const signalImpact = rollbackRateWhenPresent - rollbackRateWhenAbsent;

    // Scale impact to weight
    const hardcodedDefault = DEFAULT_SIGNAL_WEIGHTS[signal] ?? 20;
    const recomputedWeight = hardcodedDefault * (1 + signalImpact * 2);

    // Clamp to [0, 3 × hardcoded default]
    const maxWeight = 3 * hardcodedDefault;
    weights[signal] = Math.max(0, Math.min(maxWeight, recomputedWeight));
  }

  return weights;
}
