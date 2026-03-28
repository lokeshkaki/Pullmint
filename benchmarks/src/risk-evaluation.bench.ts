// benchmarks/src/risk-evaluation.bench.ts
import { registerSuite } from './harness';
import { generateSignals } from './generators';
import { evaluateRisk } from '../../services/shared/risk-evaluator';
import { DEFAULT_SIGNAL_WEIGHTS } from '../../services/shared/signal-weights';
import type { SignalType } from '../../services/shared/types';

const ALL_SIGNAL_TYPES: SignalType[] = [
  'ci.result',
  'ci.coverage',
  'author_history',
  'production.error_rate',
  'production.latency',
  'time_of_day',
  'simultaneous_deploy',
];

const signals2 = generateSignals(['ci.result', 'time_of_day']);
const signals7 = generateSignals(ALL_SIGNAL_TYPES);

// Duplicate signals — same type multiple times (dedup overhead test)
const signalsDuplicates = [
  ...generateSignals(['ci.result']),
  ...generateSignals(['ci.result']),
  ...generateSignals(['ci.result']),
  ...generateSignals(['time_of_day', 'author_history']),
];

registerSuite({
  name: 'risk-evaluation',
  iterations: 1000,
  tasks: [
    {
      name: 'evaluateRisk — 2 signals, no weights override',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 45,
          signals: signals2,
          calibrationFactor: 1.0,
          blastRadiusMultiplier: 1.0,
        });
      },
    },
    {
      name: 'evaluateRisk — all 7 signal types',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 45,
          signals: signals7,
          calibrationFactor: 1.1,
          blastRadiusMultiplier: 1.5,
        });
      },
    },
    {
      name: 'evaluateRisk — 5 duplicate signals (dedup path)',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 60,
          signals: signalsDuplicates,
          calibrationFactor: 1.0,
          blastRadiusMultiplier: 1.0,
        });
      },
    },
    {
      name: 'evaluateRisk — all 7 signals with learned weights',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 45,
          signals: signals7,
          calibrationFactor: 1.0,
          blastRadiusMultiplier: 1.0,
          signalWeights: DEFAULT_SIGNAL_WEIGHTS,
        });
      },
    },
    {
      name: 'evaluateRisk — edge: score clamp at 100',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 95,
          signals: signals7,
          calibrationFactor: 2.0,
          blastRadiusMultiplier: 2.0,
        });
      },
    },
    {
      name: 'evaluateRisk — edge: score clamp at 0',
      tags: ['cpu'],
      fn: () => {
        evaluateRisk({
          llmBaseScore: 0,
          signals: [],
          calibrationFactor: 0.5,
          blastRadiusMultiplier: 0.5,
        });
      },
    },
  ],
});
