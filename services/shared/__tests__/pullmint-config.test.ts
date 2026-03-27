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

describe('custom_agents in pullmintConfigSchema', () => {
  it('accepts a valid custom agent definition', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [
        {
          name: 'accessibility',
          type: 'accessibility',
          prompt: 'You are an accessibility expert. Analyze for WCAG compliance issues and missing ARIA attributes in the changed code.',
          model: 'claude-haiku-4-5-20251001',
          include_paths: ['src/components/**', '**/*.css'],
          exclude_paths: ['**/*.test.*'],
          weight: 0.15,
          max_diff_chars: 50000,
          severity_filter: 'medium',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data?.custom_agents).toHaveLength(1);
    expect(result.data?.custom_agents[0].name).toBe('accessibility');
    expect(result.data?.custom_agents[0].weight).toBe(0.15);
  });

  it('defaults custom_agents to empty array', () => {
    const result = pullmintConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.custom_agents).toEqual([]);
  });

  it('defaults weight to 0.10 when not specified', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [
        {
          name: 'compliance',
          type: 'compliance',
          prompt: 'You are a regulatory compliance auditor. Check for PII handling and GDPR patterns in the changed code.',
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data?.custom_agents[0].weight).toBe(0.10);
    expect(result.data?.custom_agents[0].max_diff_chars).toBe(60000);
  });

  it('rejects name with uppercase characters', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [{ name: 'MyAgent', type: 'my-agent', prompt: 'x'.repeat(50) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects prompt shorter than 50 characters', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [{ name: 'short', type: 'short', prompt: 'too short' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects prompt longer than 10000 characters', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [{ name: 'long', type: 'long', prompt: 'x'.repeat(10001) }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 5 custom agents', () => {
    const agent = {
      name: 'agent',
      type: 'agent',
      prompt: 'You are an expert reviewer analyzing code changes for quality and correctness.',
    };
    const result = pullmintConfigSchema.safeParse({
      custom_agents: Array.from({ length: 6 }, (_, i) => ({
        ...agent,
        name: `agent-${i}`,
        type: `agent-${i}`,
      })),
    });
    expect(result.success).toBe(false);
  });

  it('rejects weight above 0.50', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [
        {
          name: 'heavy',
          type: 'heavy',
          prompt: 'You are an expert reviewer analyzing code changes for quality and correctness.',
          weight: 0.75,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects weight below 0.01', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [
        {
          name: 'light',
          type: 'light',
          prompt: 'You are an expert reviewer analyzing code changes for quality and correctness.',
          weight: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('fails on unknown keys in strict mode even with custom_agents', () => {
    const result = pullmintConfigSchema.safeParse({
      custom_agents: [],
      unknown_field: true,
    });
    expect(result.success).toBe(false);
  });
});
