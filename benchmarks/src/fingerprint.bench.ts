// benchmarks/src/fingerprint.bench.ts
import { registerSuite } from './harness';
import { generateFindings } from './generators';
import * as crypto from 'crypto';
import type { Finding } from '../../services/shared/types';

// Standalone fingerprint function matching the pattern used in workers
function computeFingerprint(finding: Finding): string {
  const key = `${finding.type}:${finding.file ?? ''}:${finding.line ?? ''}:${finding.title}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function computeFingerprintBatch(findings: Finding[]): Map<string, Finding> {
  const map = new Map<string, Finding>();
  for (const f of findings) {
    map.set(computeFingerprint(f), f);
  }
  return map;
}

// Lifecycle analysis: given current and prior findings, determine new/resolved/persisted
interface LifecycleDelta {
  newFindings: Finding[];
  resolvedFindings: Finding[];
  persistedFindings: Finding[];
}

function analyzeFindingLifecycle(
  current: Finding[],
  prior: Finding[]
): LifecycleDelta {
  const currentMap = computeFingerprintBatch(current);
  const priorMap = computeFingerprintBatch(prior);

  const newFindings = current.filter((f) => !priorMap.has(computeFingerprint(f)));
  const resolvedFindings = prior.filter(
    (f) => !currentMap.has(computeFingerprint(f))
  );
  const persistedFindings = current.filter((f) =>
    priorMap.has(computeFingerprint(f))
  );

  return { newFindings, resolvedFindings, persistedFindings };
}

const single = generateFindings(1, { withFiles: true });
const batch100 = generateFindings(100, { withFiles: true });
const current20 = generateFindings(20, { withFiles: true });
const prior20 = generateFindings(20, { withFiles: true });
const current100 = generateFindings(100, { withFiles: true });
const prior80 = generateFindings(80, { withFiles: true });

registerSuite({
  name: 'fingerprint',
  iterations: 1000,
  tasks: [
    {
      name: 'computeFingerprint — single finding',
      tags: ['cpu'],
      fn: () => {
        computeFingerprint(single[0]!);
      },
    },
    {
      name: 'computeFingerprintBatch — 100 findings',
      tags: ['cpu'],
      fn: () => {
        computeFingerprintBatch(batch100);
      },
    },
    {
      name: 'analyzeFindingLifecycle — 20 current vs 20 prior',
      tags: ['cpu'],
      fn: () => {
        analyzeFindingLifecycle(current20, prior20);
      },
    },
    {
      name: 'analyzeFindingLifecycle — 100 current vs 80 prior (stress)',
      tags: ['cpu'],
      fn: () => {
        analyzeFindingLifecycle(current100, prior80);
      },
    },
  ],
});
