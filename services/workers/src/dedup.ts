import type { Finding } from '@pullmint/shared/types';

/**
 * Deduplicate findings from multiple agents.
 *
 * Rules:
 * 1. Exact match: same file + same line + same type → keep higher severity
 * 2. Overlap match: same file + lines within 5 + similar title (normalized Levenshtein < 0.30) → merge
 * 3. No cross-type dedup: findings from different agents on the same line are kept
 */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  if (findings.length <= 1) return findings;

  const severityOrder: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };

  const result: Finding[] = [];
  const used = new Set<number>();

  for (let i = 0; i < findings.length; i++) {
    if (used.has(i)) continue;

    let best = findings[i];

    for (let j = i + 1; j < findings.length; j++) {
      if (used.has(j)) continue;

      const a = best;
      const b = findings[j];

      // Cross-type: never dedup
      if (a.type !== b.type) continue;

      // Exact match: same file + same line + same type
      const sameFile = a.file != null && b.file != null && a.file === b.file;
      const sameLine =
        typeof a.line === 'number' && typeof b.line === 'number' && a.line === b.line;

      if (sameFile && sameLine) {
        // Keep the one with higher severity
        if ((severityOrder[b.severity] ?? 0) > (severityOrder[a.severity] ?? 0)) {
          best = b;
        }
        used.add(j);
        continue;
      }

      // Overlap match: same file + lines within 5 + similar title
      const nearbyLines =
        sameFile &&
        typeof a.line === 'number' &&
        typeof b.line === 'number' &&
        Math.abs(a.line - b.line) <= 5;

      if (nearbyLines) {
        const titleSimilarity = normalizedLevenshtein(a.title, b.title);
        if (titleSimilarity < 0.3) {
          // Merge: keep higher severity
          if ((severityOrder[b.severity] ?? 0) > (severityOrder[a.severity] ?? 0)) {
            best = b;
          }
          used.add(j);
        }
      }
    }

    result.push(best);
    used.add(i);
  }

  return result;
}

/**
 * Compute normalized Levenshtein distance between two strings.
 * Returns a value between 0 (identical) and 1 (completely different).
 * Normalized = distance / max(len(a), len(b))
 */
export function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return distance / maxLen;
}

/**
 * Standard Levenshtein distance implementation.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}
