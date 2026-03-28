import { deduplicateFindings, normalizedLevenshtein } from '../dedup';
import type { Finding } from '../types';

describe('deduplicateFindings', () => {
  const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
    type: 'architecture',
    severity: 'medium',
    title: 'Coupling violation',
    description: 'Module is too tightly coupled',
    ...overrides,
  });

  it('should return empty array for empty input', () => {
    expect(deduplicateFindings([])).toEqual([]);
  });

  it('should return single finding unchanged', () => {
    const findings = [makeFinding()];
    expect(deduplicateFindings(findings)).toHaveLength(1);
  });

  it('should dedup exact matches (same file + line + type), keeping higher severity', () => {
    const findings = [
      makeFinding({ file: 'src/index.ts', line: 10, severity: 'low', title: 'Issue A' }),
      makeFinding({ file: 'src/index.ts', line: 10, severity: 'high', title: 'Issue A' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
  });

  it('should dedup overlap matches (same file + nearby lines + similar title)', () => {
    const findings = [
      makeFinding({ file: 'src/index.ts', line: 10, title: 'Missing null check' }),
      makeFinding({ file: 'src/index.ts', line: 13, title: 'Missing null check here' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
  });

  it('should NOT dedup findings with different types (cross-type)', () => {
    const findings = [
      makeFinding({ type: 'architecture', file: 'src/index.ts', line: 10 }),
      makeFinding({ type: 'security', file: 'src/index.ts', line: 10 }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('should NOT dedup findings in different files', () => {
    const findings = [
      makeFinding({ file: 'src/a.ts', line: 10, title: 'Coupling violation' }),
      makeFinding({ file: 'src/b.ts', line: 10, title: 'Coupling violation' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('should NOT dedup findings with lines > 5 apart', () => {
    const findings = [
      makeFinding({ file: 'src/index.ts', line: 10, title: 'Coupling violation' }),
      makeFinding({ file: 'src/index.ts', line: 17, title: 'Coupling violation' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('should NOT dedup findings with dissimilar titles', () => {
    const findings = [
      makeFinding({ file: 'src/index.ts', line: 10, title: 'Coupling violation detected' }),
      makeFinding({ file: 'src/index.ts', line: 12, title: 'Missing error handler entirely' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('should handle findings without file or line', () => {
    const findings = [
      makeFinding({ title: 'General architecture issue' }),
      makeFinding({ title: 'Another general issue' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it('should keep exact match with same severity (first one wins)', () => {
    const findings = [
      makeFinding({ file: 'src/index.ts', line: 5, severity: 'medium', title: 'Issue X' }),
      makeFinding({ file: 'src/index.ts', line: 5, severity: 'medium', title: 'Issue X' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('medium');
  });

  it('should handle multiple groups of duplicates', () => {
    const findings = [
      makeFinding({ file: 'src/a.ts', line: 1, severity: 'low', title: 'Issue' }),
      makeFinding({ file: 'src/a.ts', line: 1, severity: 'critical', title: 'Issue' }),
      makeFinding({ file: 'src/b.ts', line: 1, severity: 'high', title: 'Other' }),
      makeFinding({ file: 'src/b.ts', line: 1, severity: 'medium', title: 'Other' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
    const aFinding = result.find((f) => f.file === 'src/a.ts');
    const bFinding = result.find((f) => f.file === 'src/b.ts');
    expect(aFinding?.severity).toBe('critical');
    expect(bFinding?.severity).toBe('high');
  });
});

describe('normalizedLevenshtein', () => {
  it('should return 0 for identical strings', () => {
    expect(normalizedLevenshtein('hello', 'hello')).toBe(0);
  });

  it('should return 1 for completely different strings', () => {
    expect(normalizedLevenshtein('abc', 'xyz')).toBe(1);
  });

  it('should return 1 when one string is empty', () => {
    expect(normalizedLevenshtein('', 'hello')).toBe(1);
    expect(normalizedLevenshtein('hello', '')).toBe(1);
  });

  it('should return small distance for similar strings', () => {
    const distance = normalizedLevenshtein('Missing null check here', 'Missing null check now');
    expect(distance).toBeLessThan(0.3);
  });

  it('should return large distance for dissimilar strings', () => {
    const distance = normalizedLevenshtein('Coupling violation', 'Missing error handler');
    expect(distance).toBeGreaterThan(0.3);
  });

  it('should be case insensitive', () => {
    expect(normalizedLevenshtein('Hello', 'hello')).toBe(0);
  });

  it('should return partial match distances correctly', () => {
    const distance = normalizedLevenshtein('kitten', 'sitting');
    expect(distance).toBeCloseTo(3 / 7, 5);
  });
});
