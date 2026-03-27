import { createHash } from 'crypto';
import type { Finding } from '@pullmint/shared/types';

/**
 * Normalize a file path for fingerprinting.
 * Strips leading slashes and lowercases so minor path variations match.
 */
function normalizeFile(file: string | undefined): string {
  if (!file) return '';
  return file.replace(/^\/+/, '').toLowerCase();
}

/**
 * Normalize a finding title for fingerprinting.
 * Lowercases, trims whitespace, and collapses multiple spaces.
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Compute a stable 16-hex-char fingerprint for a finding.
 *
 * Inputs:
 *   - finding.type  (always present)
 *   - finding.file  (normalized — leading slash stripped, lowercased)
 *   - finding.title (normalized — lowercased, trimmed)
 *
 * Deliberately excluded:
 *   - finding.line        (shifts between commits)
 *   - finding.description (LLM may rephrase identical issues)
 *   - finding.severity    (severity can change without being a new finding)
 *   - finding.suggestion  (supplementary text, not identity)
 */
export function computeFingerprint(finding: Finding): string {
  const parts = [finding.type, normalizeFile(finding.file), normalizeTitle(finding.title)];
  const raw = parts.join(':');
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Attach fingerprints to an array of findings in-place.
 * Returns a new array — original findings are not mutated.
 */
export function fingerprintFindings(findings: Finding[]): Finding[] {
  return findings.map((f) => ({
    ...f,
    fingerprint: f.fingerprint ?? computeFingerprint(f),
  }));
}
