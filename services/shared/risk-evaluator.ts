import type { Signal, RiskEvaluationInput, RiskEvaluation } from './types';

const EXPECTED_SIGNAL_TYPES = [
  'ci.result',
  'ci.coverage',
  'author_history',
  'production.error_rate',
  'production.latency',
  'time_of_day',
  'simultaneous_deploy',
] as const;

function getSignalDelta(signal: Signal): number {
  const { signalType, value } = signal;
  switch (signalType) {
    case 'ci.result':
      return value === false ? 15 : 0;
    case 'ci.coverage':
      return typeof value === 'number' && value < -10 ? 10 : 0;
    case 'production.error_rate':
      return typeof value === 'number' && value > 10 ? 20 : 0;
    case 'production.latency':
      return typeof value === 'number' && value > 20 ? 10 : 0;
    case 'time_of_day':
      return typeof value === 'number' && isFridayAfternoon(value) ? 5 : 0;
    case 'author_history':
      // value is rollback rate (0.0 - 1.0). High rollback rate increases risk.
      return typeof value === 'number' && value > 0.2 ? 10 : 0;
    case 'simultaneous_deploy':
      return value === true ? 8 : 0;
    default:
      return 0;
  }
}

function isFridayAfternoon(timestamp: number): boolean {
  const d = new Date(timestamp);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  // Cover Friday 12:00 UTC through Saturday 06:00 UTC to include UTC-7 (US Pacific) through UTC+5 (India)
  return (day === 5 && hour >= 12) || (day === 6 && hour < 6);
}

function buildReason(
  llmBaseScore: number,
  signalDelta: number,
  blastMultiplier: number,
  calibrationFactor: number,
  signals: Signal[]
): string {
  const parts: string[] = [`LLM base score: ${llmBaseScore}`];
  if (signalDelta > 0) parts.push(`signal adjustments: +${signalDelta}`);
  if (blastMultiplier > 1.0) parts.push(`blast radius multiplier: ×${blastMultiplier.toFixed(1)}`);
  if (calibrationFactor !== 1.0) parts.push(`repo calibration: ×${calibrationFactor.toFixed(2)}`);
  if (signals.length === 0) parts.push('no signals available');
  return parts.join(', ');
}

function deduplicateSignals(signals: Signal[]): Signal[] {
  const latest = new Map<string, Signal>();
  for (const s of signals) {
    const existing = latest.get(s.signalType);
    if (!existing || s.timestamp > existing.timestamp) {
      latest.set(s.signalType, s);
    }
  }
  return Array.from(latest.values());
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluation {
  const { llmBaseScore, signals, calibrationFactor, blastRadiusMultiplier } = input;

  const dedupedSignals = deduplicateSignals(signals);
  const signalDelta = dedupedSignals.reduce((sum, s) => sum + getSignalDelta(s), 0);
  // Apply multipliers only to the LLM base score so signal deltas always contribute their face value
  const adjustedBase = llmBaseScore * blastRadiusMultiplier * calibrationFactor;
  const calibrationAdjusted = adjustedBase + signalDelta;
  const score = Math.min(100, Math.round(calibrationAdjusted));

  const receivedTypes = new Set(dedupedSignals.map((s) => s.signalType));
  const missingSignals = EXPECTED_SIGNAL_TYPES.filter((t) => !receivedTypes.has(t));
  const confidence = parseFloat(
    ((EXPECTED_SIGNAL_TYPES.length - missingSignals.length) / EXPECTED_SIGNAL_TYPES.length).toFixed(
      2
    )
  );

  const reason = buildReason(
    llmBaseScore,
    signalDelta,
    blastRadiusMultiplier,
    calibrationFactor,
    dedupedSignals
  );

  return { score, confidence, missingSignals, reason };
}
