import { evaluateRisk } from '../risk-evaluator';
import type { Signal } from '../types';

const noSignals: Signal[] = [];
const baseInput = {
  llmBaseScore: 30,
  signals: noSignals,
  calibrationFactor: 1.0,
  blastRadiusMultiplier: 1.0,
};

describe('evaluateRisk', () => {
  describe('base score passthrough', () => {
    it('returns llmBaseScore unchanged when no signals and multipliers are 1.0', () => {
      const result = evaluateRisk(baseInput);
      expect(result.score).toBe(30);
    });

    it('confidence is 0 when no signals provided', () => {
      const result = evaluateRisk(baseInput);
      expect(result.confidence).toBe(0);
    });

    it('lists all expected signal types as missing when none provided', () => {
      const result = evaluateRisk(baseInput);
      expect(result.missingSignals).toContain('ci.result');
      expect(result.missingSignals).toContain('production.error_rate');
      expect(result.missingSignals).toContain('ci.coverage');
      expect(result.missingSignals).toContain('production.latency');
      expect(result.missingSignals).toContain('author_history');
      expect(result.missingSignals).toContain('time_of_day');
      expect(result.missingSignals).toContain('simultaneous_deploy');
    });

    it('returns a non-empty reason string', () => {
      const result = evaluateRisk(baseInput);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('signal adjustments', () => {
    it('adds +15 when CI result is false (failed)', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(45);
    });

    it('adds 0 when CI result is true (passed)', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds +10 when coverage drops more than 10%', () => {
      const signals: Signal[] = [
        { signalType: 'ci.coverage', value: -11, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(40);
    });

    it('adds 0 when coverage drops exactly 10% (not strictly greater than)', () => {
      const signals: Signal[] = [
        { signalType: 'ci.coverage', value: -10, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds 0 when coverage improves', () => {
      const signals: Signal[] = [
        { signalType: 'ci.coverage', value: 5, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds +20 when production error rate spikes above 10%', () => {
      const signals: Signal[] = [
        {
          signalType: 'production.error_rate',
          value: 15,
          source: 'datadog',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(50);
    });

    it('adds 0 when production error rate is exactly 10%', () => {
      const signals: Signal[] = [
        {
          signalType: 'production.error_rate',
          value: 10,
          source: 'datadog',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds +10 when production latency spikes above 20%', () => {
      const signals: Signal[] = [
        { signalType: 'production.latency', value: 25, source: 'datadog', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(40);
    });

    it('adds 0 when production latency is exactly 20%', () => {
      const signals: Signal[] = [
        { signalType: 'production.latency', value: 20, source: 'datadog', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds +5 for a Friday-afternoon deploy', () => {
      // 2026-03-13 is a Friday; 15:00 UTC = 3pm
      const fridayAfternoon = new Date('2026-03-13T15:00:00Z').getTime();
      const signals: Signal[] = [
        {
          signalType: 'time_of_day',
          value: fridayAfternoon,
          source: 'system',
          timestamp: fridayAfternoon,
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(35);
    });

    it('adds 0 for a non-Friday deploy', () => {
      // 2026-03-11 is a Wednesday
      const wednesday = new Date('2026-03-11T15:00:00Z').getTime();
      const signals: Signal[] = [
        { signalType: 'time_of_day', value: wednesday, source: 'system', timestamp: wednesday },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds 0 for a Friday morning deploy (before 12:00 UTC)', () => {
      const fridayMorning = new Date('2026-03-13T10:00:00Z').getTime();
      const signals: Signal[] = [
        {
          signalType: 'time_of_day',
          value: fridayMorning,
          source: 'system',
          timestamp: fridayMorning,
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('adds +5 for Friday 12:00 UTC (covers US Pacific Friday afternoon)', () => {
      // Friday noon UTC = Friday morning US Pacific — included in extended window
      const fridayNoonUTC = new Date('2026-03-13T12:00:00Z').getTime();
      const signals: Signal[] = [
        {
          signalType: 'time_of_day',
          value: fridayNoonUTC,
          source: 'system',
          timestamp: fridayNoonUTC,
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(35);
    });

    it('adds +5 for Saturday 03:00 UTC (Friday evening US Pacific)', () => {
      // Saturday 03:00 UTC = Friday 8pm US Pacific — still in extended window
      const saturdayEarlyUTC = new Date('2026-03-14T03:00:00Z').getTime();
      const signals: Signal[] = [
        {
          signalType: 'time_of_day',
          value: saturdayEarlyUTC,
          source: 'system',
          timestamp: saturdayEarlyUTC,
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(35);
    });

    it('adds 0 for Saturday 07:00 UTC (past the extended window)', () => {
      const saturdayMorningUTC = new Date('2026-03-14T07:00:00Z').getTime();
      const signals: Signal[] = [
        {
          signalType: 'time_of_day',
          value: saturdayMorningUTC,
          source: 'system',
          timestamp: saturdayMorningUTC,
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('uses only the latest signal when duplicate types are supplied', () => {
      // Two ci.result: false — should still be +15, not +30
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: 1000 },
        { signalType: 'ci.result', value: false, source: 'github', timestamp: 2000 },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(45);
    });

    it('uses the latest signal value when duplicate types conflict', () => {
      // Earlier: false (+15), Later: true (+0) — latest wins, score stays at 30
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: 1000 },
        { signalType: 'ci.result', value: true, source: 'github', timestamp: 2000 },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('combines multiple signal deltas additively before multipliers', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() }, // +15
        { signalType: 'ci.coverage', value: -15, source: 'github', timestamp: Date.now() }, // +10
      ];
      // (30 + 15 + 10) * 1.0 * 1.0 = 55
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(55);
    });

    it('adds +8 when a simultaneous dependent deploy is in progress', () => {
      const signals: Signal[] = [
        {
          signalType: 'simultaneous_deploy',
          value: true,
          source: 'pullmint',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(38);
    });

    it('adds 0 for simultaneous_deploy when value is false', () => {
      const signals: Signal[] = [
        {
          signalType: 'simultaneous_deploy',
          value: false,
          source: 'pullmint',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('applies author_history delta when rollback rate exceeds 0.2', () => {
      const signals: Signal[] = [
        { signalType: 'author_history', value: 0.4, source: 'pullmint', timestamp: Date.now() },
      ];
      // rollback rate 40% > 20% threshold → +10
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(40);
    });

    it('adds 0 for author_history when rollback rate is at or below 0.2', () => {
      const signals: Signal[] = [
        { signalType: 'author_history', value: 0.2, source: 'pullmint', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });

    it('ignores unknown signal types', () => {
      const signals = [
        {
          signalType: 'unknown.signal' as Signal['signalType'],
          value: 999,
          source: 'unknown',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(30);
    });
  });

  describe('multipliers', () => {
    it('applies blastRadiusMultiplier to base score only, not signal deltas', () => {
      // 30 * 2.0 * 1.0 + 15 = 75 — multipliers apply only to LLM base, signal deltas add at face value
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
      ];
      expect(evaluateRisk({ ...baseInput, signals, blastRadiusMultiplier: 2.0 }).score).toBe(75);
    });

    it('applies calibrationFactor after blastRadiusMultiplier', () => {
      // 30 * 1.0 * 2.0 = 60
      expect(evaluateRisk({ ...baseInput, calibrationFactor: 2.0 }).score).toBe(60);
    });

    it('applies both multipliers in correct order: blast then calibration', () => {
      // 30 * 2.0 * 1.5 = 90
      expect(
        evaluateRisk({ ...baseInput, blastRadiusMultiplier: 2.0, calibrationFactor: 1.5 }).score
      ).toBe(90);
    });

    it('caps final score at 100', () => {
      // 30 * 3.0 * 2.0 = 180 → capped at 100
      expect(
        evaluateRisk({ ...baseInput, blastRadiusMultiplier: 3.0, calibrationFactor: 2.0 }).score
      ).toBe(100);
    });

    it('calibrationFactor 0.5 halves the score', () => {
      // 30 * 1.0 * 0.5 = 15
      expect(evaluateRisk({ ...baseInput, calibrationFactor: 0.5 }).score).toBe(15);
    });

    it('blastRadiusMultiplier 1.0 (leaf service) applies no multiplier', () => {
      expect(evaluateRisk({ ...baseInput, blastRadiusMultiplier: 1.0 }).score).toBe(30);
    });

    it('score of 0 stays 0 regardless of multipliers', () => {
      expect(
        evaluateRisk({
          ...baseInput,
          llmBaseScore: 0,
          blastRadiusMultiplier: 3.0,
          calibrationFactor: 2.0,
        }).score
      ).toBe(0);
    });

    it('should not amplify signal deltas by both multipliers', () => {
      // blastRadius=1.5, calibration=1.5, CI fail (+15)
      // New formula: 20 * 1.5 * 1.5 + 15 = 45 + 15 = 60
      // Old formula would have produced: (20 + 15) * 1.5 * 1.5 = 78.75 → 79
      const result = evaluateRisk({
        llmBaseScore: 20,
        signals: [{ signalType: 'ci.result', value: false, timestamp: Date.now(), source: 'ci' }],
        calibrationFactor: 1.5,
        blastRadiusMultiplier: 1.5,
      });
      expect(result.score).toBe(60);
    });
  });

  describe('confidence', () => {
    it('is 1.0 when all expected signals are present', () => {
      const allSignals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: Date.now() },
        { signalType: 'ci.coverage', value: 0, source: 'github', timestamp: Date.now() },
        { signalType: 'author_history', value: 0.95, source: 'pullmint', timestamp: Date.now() },
        { signalType: 'production.error_rate', value: 0, source: 'datadog', timestamp: Date.now() },
        { signalType: 'production.latency', value: 0, source: 'datadog', timestamp: Date.now() },
        { signalType: 'time_of_day', value: Date.now(), source: 'system', timestamp: Date.now() },
        {
          signalType: 'simultaneous_deploy',
          value: false,
          source: 'pullmint',
          timestamp: Date.now(),
        },
      ];
      expect(evaluateRisk({ ...baseInput, signals: allSignals }).confidence).toBe(1.0);
    });

    it('is approximately 3/7 when 3 of 7 expected signals are present', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: Date.now() },
        { signalType: 'ci.coverage', value: 0, source: 'github', timestamp: Date.now() },
        { signalType: 'author_history', value: 0.9, source: 'pullmint', timestamp: Date.now() },
      ];
      // 3 of 7 ≈ 0.43
      expect(evaluateRisk({ ...baseInput, signals }).confidence).toBeCloseTo(3 / 7, 2);
    });

    it('does not count duplicate signal types toward confidence more than once', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: 1000 },
        { signalType: 'ci.result', value: false, source: 'github', timestamp: 2000 }, // same type, different time
      ];
      // ci.result present once in the set of expected types — still 1/7
      const result = evaluateRisk({ ...baseInput, signals });
      expect(result.confidence).toBeCloseTo(1 / 7, 2);
    });

    it('missing signals list excludes signal types that are present', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: Date.now() },
      ];
      const result = evaluateRisk({ ...baseInput, signals });
      expect(result.missingSignals).not.toContain('ci.result');
      expect(result.missingSignals).toContain('production.error_rate');
    });

    it('includes simultaneous_deploy in expected signals for confidence calculation', () => {
      const signals: Signal[] = [
        {
          signalType: 'simultaneous_deploy',
          value: true,
          source: 'pullmint',
          timestamp: Date.now(),
        },
      ];
      const result = evaluateRisk({ ...baseInput, signals });
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.missingSignals).not.toContain('simultaneous_deploy');
    });
  });

  describe('learned signal weights', () => {
    it('uses hardcoded defaults when signalWeights is omitted (backward compatibility)', () => {
      // ci.result: false (+15), production.error_rate: 15 (+20) → total delta = 35
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
        { signalType: 'production.error_rate', value: 15, source: 'datadog', timestamp: Date.now() },
      ];
      // 30 + 15 + 20 = 65
      expect(evaluateRisk({ ...baseInput, signals }).score).toBe(65);
    });

    it('uses learned weights when signalWeights is provided', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
        { signalType: 'production.error_rate', value: 15, source: 'datadog', timestamp: Date.now() },
      ];
      // learned: ci.result=25, production.error_rate=30 → delta = 55 → 30 + 25 + 30 = 85
      expect(
        evaluateRisk({
          ...baseInput,
          signals,
          signalWeights: { 'ci.result': 25, 'production.error_rate': 30 },
        }).score
      ).toBe(85);
    });

    it('learned weight of 0 effectively disables a signal', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
      ];
      // ci.result weight=0 → contributes 0 → score stays at 30
      expect(
        evaluateRisk({ ...baseInput, signals, signalWeights: { 'ci.result': 0 } }).score
      ).toBe(30);
    });

    it('threshold-not-met signals contribute 0 regardless of learned weight', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: true, source: 'github', timestamp: Date.now() },
      ];
      // CI passed → threshold not met, weight irrelevant → score stays at 30
      expect(
        evaluateRisk({ ...baseInput, signals, signalWeights: { 'ci.result': 25 } }).score
      ).toBe(30);
    });

    it('missing signal types in signalWeights fall back to hardcoded defaults', () => {
      const signals: Signal[] = [
        { signalType: 'ci.result', value: false, source: 'github', timestamp: Date.now() },
        { signalType: 'production.error_rate', value: 15, source: 'datadog', timestamp: Date.now() },
      ];
      // ci.result uses learned weight 25, production.error_rate falls back to hardcoded 20
      // 30 + 25 + 20 = 75
      expect(
        evaluateRisk({ ...baseInput, signals, signalWeights: { 'ci.result': 25 } }).score
      ).toBe(75);
    });
  });
});
