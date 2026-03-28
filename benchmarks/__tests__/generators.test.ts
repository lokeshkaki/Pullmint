import {
  generateDiff,
  generateFindings,
  generateSignals,
  generateDiffBySize,
} from '../src/generators';

describe('generators', () => {
  describe('generateDiff', () => {
    it('produces a valid unified diff string', () => {
      const diff = generateDiff(2, 10);
      expect(typeof diff).toBe('string');
      expect(diff).toContain('diff --git');
      expect(diff).toContain('@@');
    });

    it('contains the requested number of files', () => {
      const diff = generateDiff(5, 5);
      const fileHeaders = diff.match(/^diff --git/gm);
      expect(fileHeaders).toHaveLength(5);
    });

    it('produces non-empty output for single file', () => {
      const diff = generateDiff(1, 3);
      expect(diff.length).toBeGreaterThan(0);
    });
  });

  describe('generateFindings', () => {
    it('returns the requested count', () => {
      const findings = generateFindings(10);
      expect(findings).toHaveLength(10);
    });

    it('findings have required properties', () => {
      const findings = generateFindings(3);
      for (const f of findings) {
        expect(f).toHaveProperty('type');
        expect(f).toHaveProperty('severity');
        expect(f).toHaveProperty('title');
        expect(f).toHaveProperty('description');
      }
    });

    it('respects options.withFiles when false', () => {
      const findings = generateFindings(5, { withFiles: false });
      for (const f of findings) {
        expect(f.file).toBeUndefined();
        expect(f.line).toBeUndefined();
      }
    });

    it('returns empty array for count 0', () => {
      const findings = generateFindings(0);
      expect(findings).toHaveLength(0);
    });

    it('produces duplicate findings when duplicateRate > 0', () => {
      // With duplicateRate=1 all entries after first should be variants
      const findings = generateFindings(10, { duplicateRate: 1 });
      expect(findings.length).toBeGreaterThan(0);
    });
  });

  describe('generateSignals', () => {
    it('returns an array of signal objects', () => {
      const signals = generateSignals(['ci.result', 'time_of_day']);
      expect(Array.isArray(signals)).toBe(true);
    });

    it('returns one signal per type', () => {
      const signals = generateSignals(['ci.result', 'time_of_day', 'author_history']);
      expect(signals).toHaveLength(3);
    });

    it('each signal has required properties', () => {
      const signals = generateSignals(['ci.result']);
      expect(signals[0]).toHaveProperty('signalType', 'ci.result');
      expect(signals[0]).toHaveProperty('value');
      expect(signals[0]).toHaveProperty('source');
      expect(signals[0]).toHaveProperty('timestamp');
    });

    it('returns empty array for empty types array', () => {
      const signals = generateSignals([]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('generateDiffBySize', () => {
    it('generates small diff', () => {
      const result = generateDiffBySize('small');
      expect(typeof result.raw).toBe('string');
      expect(result.raw.length).toBeGreaterThan(0);
    });

    it('generates medium diff with more content than small', () => {
      const small = generateDiffBySize('small');
      const medium = generateDiffBySize('medium');
      expect(medium.raw.length).toBeGreaterThan(small.raw.length);
    });

    it('generates large diff with more content than medium', () => {
      const medium = generateDiffBySize('medium');
      const large = generateDiffBySize('large');
      expect(large.raw.length).toBeGreaterThan(medium.raw.length);
    });

    it('generates xl diff', () => {
      const result = generateDiffBySize('xl');
      expect(typeof result.raw).toBe('string');
      expect(result.raw.length).toBeGreaterThan(0);
    });
  });
});
