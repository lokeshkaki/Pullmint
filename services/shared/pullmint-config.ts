import { z } from 'zod';

export const severityThresholdSchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const agentsConfigSchema = z
  .object({
    architecture: z.boolean().default(true),
    security: z.boolean().default(true),
    performance: z.boolean().default(true),
    style: z.boolean().default(true),
  })
  .default({
    architecture: true,
    security: true,
    performance: true,
    style: true,
  });

export const customAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
  type: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9-]*$/, 'type must be lowercase kebab-case'),
  prompt: z
    .string()
    .min(50, 'prompt must be at least 50 characters')
    .max(10000, 'prompt must not exceed 10000 characters'),
  model: z.string().optional(),
  include_paths: z.array(z.string()).optional(),
  exclude_paths: z.array(z.string()).optional(),
  weight: z.number().min(0.01).max(0.5).default(0.1),
  max_diff_chars: z.number().min(10000).max(200000).default(60000),
  severity_filter: severityThresholdSchema.optional(),
});

export type CustomAgentConfig = z.infer<typeof customAgentSchema>;

export const pullmintConfigSchema = z
  .object({
    severity_threshold: severityThresholdSchema.default('low'),
    ignore_paths: z.array(z.string()).default([]),
    agents: agentsConfigSchema,
    auto_approve_below: z.number().min(0).max(100).optional(),
    custom_agents: z.array(customAgentSchema).max(5).default([]),
  })
  .strict();

export type PullmintConfig = z.infer<typeof pullmintConfigSchema>;

export const DEFAULT_CONFIG: PullmintConfig = pullmintConfigSchema.parse({});

export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'] as const;

export function filterFindingsBySeverity<T extends { severity: string }>(
  findings: T[],
  threshold: string
): T[] {
  const minIndex = SEVERITY_ORDER.indexOf(threshold as (typeof SEVERITY_ORDER)[number]);
  if (minIndex === -1) {
    return findings;
  }

  return findings.filter(
    (finding) =>
      SEVERITY_ORDER.indexOf(finding.severity as (typeof SEVERITY_ORDER)[number]) >= minIndex
  );
}
