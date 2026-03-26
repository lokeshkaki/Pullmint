import { DEFAULT_CONFIG, filterFindingsBySeverity, pullmintConfigSchema } from '../pullmint-config';

describe('pullmintConfigSchema', () => {
  it('parses a valid full config', () => {
    const result = pullmintConfigSchema.safeParse({
      severity_threshold: 'medium',
      ignore_paths: ['generated/**', 'vendor/**'],
      agents: { architecture: true, security: true, performance: false, style: true },
      auto_approve_below: 25,
    });

    expect(result.success).toBe(true);
    expect(result.data?.agents.performance).toBe(false);
  });

  it('applies defaults for empty config', () => {
    const result = pullmintConfigSchema.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual(DEFAULT_CONFIG);
  });

  it('applies defaults for partial config', () => {
    const result = pullmintConfigSchema.safeParse({ severity_threshold: 'high' });

    expect(result.success).toBe(true);
    expect(result.data?.severity_threshold).toBe('high');
    expect(result.data?.agents.architecture).toBe(true);
  });

  it('fails on unknown keys in strict mode', () => {
    const result = pullmintConfigSchema.safeParse({
      severity_threshold: 'low',
      unknown_key: true,
    });

    expect(result.success).toBe(false);
  });

  it('fails on invalid severity values', () => {
    const result = pullmintConfigSchema.safeParse({ severity_threshold: 'extreme' });

    expect(result.success).toBe(false);
  });

  it('fails when auto_approve_below exceeds 100', () => {
    const result = pullmintConfigSchema.safeParse({ auto_approve_below: 150 });

    expect(result.success).toBe(false);
  });
});

describe('filterFindingsBySeverity', () => {
  const findings = [
    { severity: 'info', title: 'a' },
    { severity: 'low', title: 'b' },
    { severity: 'medium', title: 'c' },
    { severity: 'high', title: 'd' },
    { severity: 'critical', title: 'e' },
  ];

  it('returns all findings at info threshold', () => {
    expect(filterFindingsBySeverity(findings, 'info')).toHaveLength(5);
  });

  it('filters out info and low at medium threshold', () => {
    const result = filterFindingsBySeverity(findings, 'medium');

    expect(result).toHaveLength(3);
    expect(result.map((finding) => finding.severity)).toEqual(['medium', 'high', 'critical']);
  });

  it('returns only critical at critical threshold', () => {
    expect(filterFindingsBySeverity(findings, 'critical')).toHaveLength(1);
  });
});
