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

export const pullmintConfigSchema = z
  .object({
    severity_threshold: severityThresholdSchema.default('low'),
    ignore_paths: z.array(z.string()).default([]),
    agents: agentsConfigSchema,
    auto_approve_below: z.number().min(0).max(100).optional(),
    monthly_budget_usd: z.number().positive().optional(),
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
