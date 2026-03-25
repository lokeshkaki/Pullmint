import type { Signal, RiskEvaluationInput, RiskEvaluation, SignalWeights } from './types';

const EXPECTED_SIGNAL_TYPES = [
  'ci.result',
  'ci.coverage',
  'author_history',
  'production.error_rate',
  'production.latency',
  'time_of_day',
  'simultaneous_deploy',
] as const;

function getSignalDelta(signal: Signal, signalWeights?: SignalWeights): number {
  const { signalType, value } = signal;

  // Each case checks the threshold condition (unchanged).
  // When met, the delta comes from learned weights if available, else hardcoded.
  switch (signalType) {
    case 'ci.result':
      if (value === false) return signalWeights?.['ci.result'] ?? 15;
      return 0;
    case 'ci.coverage':
      if (typeof value === 'number' && value < -10) return signalWeights?.['ci.coverage'] ?? 10;
      return 0;
    case 'production.error_rate':
      if (typeof value === 'number' && value > 10)
        return signalWeights?.['production.error_rate'] ?? 20;
      return 0;
    case 'production.latency':
      if (typeof value === 'number' && value > 20)
        return signalWeights?.['production.latency'] ?? 10;
      return 0;
    case 'time_of_day':
      if (typeof value === 'number' && isFridayAfternoon(value))
        return signalWeights?.['time_of_day'] ?? 5;
      return 0;
    case 'author_history':
      // value is rollback rate (0.0 - 1.0). High rollback rate increases risk.
      if (typeof value === 'number' && value > 0.2) return signalWeights?.['author_history'] ?? 10;
      return 0;
    case 'simultaneous_deploy':
      if (value === true) return signalWeights?.['simultaneous_deploy'] ?? 8;
      return 0;
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

export function evaluateRisk(
  input: RiskEvaluationInput & {
    signalWeights?: SignalWeights;
  }
): RiskEvaluation {
  const { llmBaseScore, signals, calibrationFactor, blastRadiusMultiplier, signalWeights } = input;

  const dedupedSignals = deduplicateSignals(signals);
  const signalDelta = dedupedSignals.reduce((sum, s) => sum + getSignalDelta(s, signalWeights), 0);
  // Apply multipliers only to the LLM base score so signal deltas always contribute their face value
  const adjustedBase = llmBaseScore * blastRadiusMultiplier * calibrationFactor;
  const calibrationAdjusted = adjustedBase + signalDelta;
  const score = Math.max(0, Math.min(100, Math.round(calibrationAdjusted)));

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
