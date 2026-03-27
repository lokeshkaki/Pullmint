import { computeFingerprint, fingerprintFindings } from '../src/finding-fingerprint';
import type { Finding } from '../../shared/types';

const baseFinding: Finding = {
  type: 'security',
  severity: 'high',
  title: 'Missing input validation',
  description: 'User input is not validated before processing.',
  file: 'src/api/users.ts',
  line: 42,
};

describe('computeFingerprint', () => {
  it('returns a 16-char hex string', () => {
    const fp = computeFingerprint(baseFinding);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same finding', () => {
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(baseFinding));
  });

  it('is stable across line number changes', () => {
    const shifted: Finding = { ...baseFinding, line: 99 };
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(shifted));
  });

  it('is stable across description changes', () => {
    const rephrased: Finding = { ...baseFinding, description: 'Input not sanitized - XSS risk.' };
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(rephrased));
  });

  it('is stable across severity changes', () => {
    const downgraded: Finding = { ...baseFinding, severity: 'medium' };
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(downgraded));
  });

  it('differs when type changes', () => {
    const otherType: Finding = { ...baseFinding, type: 'performance' };
    expect(computeFingerprint(baseFinding)).not.toBe(computeFingerprint(otherType));
  });

  it('differs when title changes significantly', () => {
    const otherTitle: Finding = { ...baseFinding, title: 'SQL injection vulnerability' };
    expect(computeFingerprint(baseFinding)).not.toBe(computeFingerprint(otherTitle));
  });

  it('differs when file changes', () => {
    const otherFile: Finding = { ...baseFinding, file: 'src/api/products.ts' };
    expect(computeFingerprint(baseFinding)).not.toBe(computeFingerprint(otherFile));
  });

  it('strips leading slashes from file paths', () => {
    const withSlash: Finding = { ...baseFinding, file: '/src/api/users.ts' };
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(withSlash));
  });

  it('is case-insensitive for file paths', () => {
    const upperFile: Finding = { ...baseFinding, file: 'SRC/API/USERS.TS' };
    expect(computeFingerprint(baseFinding)).toBe(computeFingerprint(upperFile));
  });

  it('handles findings without a file (type + title only)', () => {
    const noFile: Finding = { ...baseFinding, file: undefined, line: undefined };
    const fp = computeFingerprint(noFile);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toBe(computeFingerprint(baseFinding));
  });

  it('normalizes title whitespace', () => {
    const extraSpaces: Finding = { ...baseFinding, title: '  Missing   input   validation  ' };
    expect(computeFingerprint(extraSpaces)).toBe(computeFingerprint(baseFinding));
  });
});

describe('fingerprintFindings', () => {
  it('attaches fingerprints to all findings', () => {
    const result = fingerprintFindings([baseFinding]);
    expect(result[0].fingerprint).toBeDefined();
    expect(result[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not mutate the original findings array', () => {
    const original = [baseFinding];
    const result = fingerprintFindings(original);
    expect(original[0].fingerprint).toBeUndefined();
    expect(result[0].fingerprint).toBeDefined();
  });

  it('preserves an existing fingerprint', () => {
    const alreadyTagged: Finding = { ...baseFinding, fingerprint: 'deadbeef12345678' };
    const result = fingerprintFindings([alreadyTagged]);
    expect(result[0].fingerprint).toBe('deadbeef12345678');
  });

  it('handles empty array', () => {
    expect(fingerprintFindings([])).toEqual([]);
  });
});
