import { normalizedLevenshtein } from './dedup';
import { fingerprintFindings } from './finding-fingerprint';
import type { Finding, FindingLifecycleResult } from '@pullmint/shared/types';

const FUZZY_TITLE_THRESHOLD = 0.35;

/**
 * Analyze finding lifecycle between two runs of the same PR.
 */
export function analyzeFindingLifecycle(
  currentFindings: Finding[],
  priorFindings: Finding[]
): FindingLifecycleResult {
  // Short-circuit: no prior findings means everything is new
  if (priorFindings.length === 0) {
    const findings = fingerprintFindings(currentFindings).map((f) => ({
      ...f,
      lifecycle: 'new' as const,
    }));
    return { findings, resolved: [], stats: { new: findings.length, persisted: 0, resolved: 0 } };
  }

  // Short-circuit: no current findings means everything resolved
  if (currentFindings.length === 0) {
    const resolved = fingerprintFindings(priorFindings).map((f) => ({
      ...f,
      lifecycle: 'resolved' as const,
    }));
    return {
      findings: [],
      resolved,
      stats: { new: 0, persisted: 0, resolved: resolved.length },
    };
  }

  const taggedCurrent = fingerprintFindings(currentFindings);
  const taggedPrior = fingerprintFindings(priorFindings);

  const priorByFingerprint = new Map<string, Finding>();
  for (const pf of taggedPrior) {
    if (pf.fingerprint) {
      priorByFingerprint.set(pf.fingerprint, pf);
    }
  }

  const matchedPriorFingerprints = new Set<string>();

  const findings: Finding[] = taggedCurrent.map((cf) => {
    // 1. Exact fingerprint match
    if (cf.fingerprint && priorByFingerprint.has(cf.fingerprint)) {
      matchedPriorFingerprints.add(cf.fingerprint);
      return { ...cf, lifecycle: 'persisted' as const };
    }

    // 2. Fuzzy fallback: same type + same normalized file + similar title
    const normalizedCfFile = (cf.file ?? '').replace(/^\/+/, '').toLowerCase();
    for (const pf of taggedPrior) {
      if (pf.type !== cf.type) continue;

      const normalizedPfFile = (pf.file ?? '').replace(/^\/+/, '').toLowerCase();
      if (normalizedCfFile !== normalizedPfFile) continue;

      const titleDistance = normalizedLevenshtein(
        cf.title.toLowerCase().trim(),
        pf.title.toLowerCase().trim()
      );
      if (titleDistance < FUZZY_TITLE_THRESHOLD) {
        if (pf.fingerprint) {
          matchedPriorFingerprints.add(pf.fingerprint);
        }
        return { ...cf, lifecycle: 'persisted' as const };
      }
    }

    // 3. No match => new
    return { ...cf, lifecycle: 'new' as const };
  });

  const resolved: Finding[] = taggedPrior
    .filter((pf) => pf.fingerprint && !matchedPriorFingerprints.has(pf.fingerprint))
    .map((pf) => ({ ...pf, lifecycle: 'resolved' as const }));

  const stats = {
    new: findings.filter((f) => f.lifecycle === 'new').length,
    persisted: findings.filter((f) => f.lifecycle === 'persisted').length,
    resolved: resolved.length,
  };

  return { findings, resolved, stats };
}
