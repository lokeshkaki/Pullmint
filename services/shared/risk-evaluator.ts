import type { Signal, RiskEvaluationInput, RiskEvaluation } from './types';

const EXPECTED_SIGNAL_TYPES = [
  'ci.result',
  'ci.coverage',
  'author_history',
  'production.error_rate',
  'production.latency',
  'time_of_day',
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
    default:
      return 0;
  }
}

function isFridayAfternoon(timestamp: number): boolean {
  const d = new Date(timestamp);
  return d.getUTCDay() === 5 && d.getUTCHours() >= 15;
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

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluation {
  const { llmBaseScore, signals, calibrationFactor, blastRadiusMultiplier } = input;

  const signalDelta = signals.reduce((sum, s) => sum + getSignalDelta(s), 0);
  const rawScore = llmBaseScore + signalDelta;
  const blastAdjusted = rawScore * blastRadiusMultiplier;
  const calibrationAdjusted = blastAdjusted * calibrationFactor;
  const score = Math.min(100, Math.round(calibrationAdjusted));

  const receivedTypes = new Set(signals.map((s) => s.signalType));
  const missingSignals = EXPECTED_SIGNAL_TYPES.filter((t) => !receivedTypes.has(t));
  const confidence = parseFloat(
    ((EXPECTED_SIGNAL_TYPES.length - missingSignals.length) / EXPECTED_SIGNAL_TYPES.length).toFixed(2)
  );

  const reason = buildReason(llmBaseScore, signalDelta, blastRadiusMultiplier, calibrationFactor, signals);

  return { score, confidence, missingSignals, reason };
}
