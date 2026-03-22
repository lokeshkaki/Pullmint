import { eq } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { retryWithBackoff } from '@pullmint/shared/error-handling';
import { evaluateRisk } from '@pullmint/shared/risk-evaluator';
import { resolveSignalWeights } from '@pullmint/shared/signal-weights';
import type { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import type { PREvent, Signal, CheckpointRecord } from '@pullmint/shared/types';

type OctokitClient = Awaited<ReturnType<typeof getGitHubInstallationClient>>;
type DrizzleDb = ReturnType<typeof getDb>;

export async function buildAnalysisCheckpoint(
  prEvent: PREvent & { executionId: string },
  llmBaseScore: number,
  ownerRepo: [string, string],
  octokit: OctokitClient,
  db: DrizzleDb
): Promise<{ checkpoint1: CheckpointRecord; calibrationFactor: number }> {
  const [owner, repo] = ownerRepo;
  const signals: Signal[] = [];

  // CI result signal
  try {
    const checks = await retryWithBackoff(
      () =>
        octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: prEvent.headSha,
        }),
      { maxAttempts: 2, baseDelayMs: 500 }
    );
    const ciPassed = checks.data.check_runs.every((r) => r.conclusion === 'success');
    signals.push({
      signalType: 'ci.result',
      value: ciPassed,
      source: 'github',
      timestamp: Date.now(),
    });
  } catch {
    // Checks API unavailable — omit CI signal
  }

  signals.push({
    signalType: 'time_of_day',
    value: Date.now(),
    source: 'system',
    timestamp: Date.now(),
  });

  // Calibration factor
  let calibrationFactor = 1.0;
  const [calRecord] = await db
    .select({ calibrationFactor: schema.calibrations.calibrationFactor })
    .from(schema.calibrations)
    .where(eq(schema.calibrations.repoFullName, prEvent.repoFullName))
    .limit(1);

  if (calRecord) {
    calibrationFactor = calRecord.calibrationFactor ?? 1.0;
  }

  // Resolve learned signal weights
  const signalWeights = await resolveSignalWeights(prEvent.repoFullName, db);

  const evaluation = evaluateRisk({
    llmBaseScore,
    signals,
    calibrationFactor,
    blastRadiusMultiplier: 1.0,
    signalWeights,
  });

  const checkpoint1: CheckpointRecord = {
    type: 'analysis',
    score: evaluation.score,
    confidence: evaluation.confidence,
    missingSignals: evaluation.missingSignals,
    signals,
    decision: evaluation.score >= 40 ? 'held' : 'approved',
    reason: evaluation.reason,
    evaluatedAt: Date.now(),
  };

  return { checkpoint1, calibrationFactor };
}
