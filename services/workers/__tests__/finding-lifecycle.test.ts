import { analyzeFindingLifecycle } from '../src/finding-lifecycle';
import type { Finding } from '../../shared/types';

const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  type: 'security',
  severity: 'high',
  title: 'Missing input validation',
  description: 'Input not validated.',
  file: 'src/api/users.ts',
  line: 42,
  ...overrides,
});

describe('analyzeFindingLifecycle', () => {
  describe('edge cases', () => {
    it('returns all new when no prior findings', () => {
      const current = [makeFinding(), makeFinding({ title: 'SQL injection', file: 'src/db.ts' })];
      const result = analyzeFindingLifecycle(current, []);
      expect(result.stats).toEqual({ new: 2, persisted: 0, resolved: 0 });
      expect(result.findings.every((f: Finding) => f.lifecycle === 'new')).toBe(true);
      expect(result.resolved).toHaveLength(0);
    });

    it('returns all resolved when no current findings', () => {
      const prior = [makeFinding(), makeFinding({ title: 'SQL injection', file: 'src/db.ts' })];
      const result = analyzeFindingLifecycle([], prior);
      expect(result.stats).toEqual({ new: 0, persisted: 0, resolved: 2 });
      expect(result.findings).toHaveLength(0);
      expect(result.resolved.every((f: Finding) => f.lifecycle === 'resolved')).toBe(true);
    });

    it('handles both empty arrays', () => {
      const result = analyzeFindingLifecycle([], []);
      expect(result.stats).toEqual({ new: 0, persisted: 0, resolved: 0 });
      expect(result.findings).toHaveLength(0);
      expect(result.resolved).toHaveLength(0);
    });
  });

  describe('exact fingerprint matching', () => {
    it('marks finding as persisted when fingerprint matches', () => {
      const finding = makeFinding();
      const prior = [{ ...finding, line: 50 }];
      const result = analyzeFindingLifecycle([finding], prior);
      expect(result.findings[0].lifecycle).toBe('persisted');
      expect(result.stats.persisted).toBe(1);
      expect(result.stats.new).toBe(0);
      expect(result.resolved).toHaveLength(0);
    });

    it('marks finding as new when no fingerprint match', () => {
      const current = makeFinding({ title: 'Completely different issue' });
      const prior = [makeFinding({ title: 'Some other issue' })];
      const result = analyzeFindingLifecycle([current], prior);
      expect(result.findings[0].lifecycle).toBe('new');
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].lifecycle).toBe('resolved');
    });
  });

  describe('fuzzy fallback matching', () => {
    it('treats finding as persisted when title is slightly rephrased (same type + file)', () => {
      const current = makeFinding({ title: 'Missing input validations' });
      const prior = [makeFinding({ title: 'Missing input validation' })];
      const result = analyzeFindingLifecycle([current], prior);
      expect(result.findings[0].lifecycle).toBe('persisted');
    });

    it('does not fuzzy-match across different files', () => {
      const current = makeFinding({ title: 'Missing validation', file: 'src/api/orders.ts' });
      const prior = [makeFinding({ title: 'Missing validation', file: 'src/api/users.ts' })];
      const result = analyzeFindingLifecycle([current], prior);
      expect(result.findings[0].lifecycle).toBe('new');
      expect(result.resolved).toHaveLength(1);
    });

    it('does not fuzzy-match across different types', () => {
      const current = makeFinding({ title: 'Missing validation', type: 'performance' });
      const prior = [makeFinding({ title: 'Missing validation', type: 'security' })];
      const result = analyzeFindingLifecycle([current], prior);
      expect(result.findings[0].lifecycle).toBe('new');
    });
  });

  describe('resolved findings', () => {
    it('marks prior findings not in current as resolved', () => {
      const currentFinding = makeFinding({ title: 'Persisted issue' });
      const resolvedFinding = makeFinding({ title: 'Fixed SQL injection', file: 'src/db.ts' });
      const result = analyzeFindingLifecycle([currentFinding], [currentFinding, resolvedFinding]);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].title).toBe('Fixed SQL injection');
      expect(result.resolved[0].lifecycle).toBe('resolved');
    });
  });

  describe('mixed scenario', () => {
    it('handles new, persisted, and resolved findings in one call', () => {
      const persisted = makeFinding({ title: 'Persisted finding', file: 'src/auth.ts' });
      const newFinding = makeFinding({ title: 'New XSS risk', file: 'src/templates.ts' });
      const resolved = makeFinding({ title: 'Now fixed issue', file: 'src/utils.ts' });

      const current = [persisted, newFinding];
      const prior = [persisted, resolved];

      const result = analyzeFindingLifecycle(current, prior);

      expect(result.stats.persisted).toBe(1);
      expect(result.stats.new).toBe(1);
      expect(result.stats.resolved).toBe(1);

      const persistedResult = result.findings.find((f: Finding) => f.title === 'Persisted finding');
      const newResult = result.findings.find((f: Finding) => f.title === 'New XSS risk');
      expect(persistedResult?.lifecycle).toBe('persisted');
      expect(newResult?.lifecycle).toBe('new');
      expect(result.resolved[0].title).toBe('Now fixed issue');
    });
  });

  describe('fingerprint stability across runs', () => {
    it('attaches fingerprints to all output findings', () => {
      const result = analyzeFindingLifecycle([makeFinding()], []);
      expect(result.findings[0].fingerprint).toBeDefined();
      expect(result.findings[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('attaches fingerprints to resolved findings', () => {
      const result = analyzeFindingLifecycle([], [makeFinding()]);
      expect(result.resolved[0].fingerprint).toBeDefined();
    });
  });
});
