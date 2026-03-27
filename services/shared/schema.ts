import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  vector,
} from 'drizzle-orm/pg-core';
import type { SignalWeights, OutcomeLogEntry } from './types';

export const webhookDedup = pgTable('webhook_dedup', {
  deliveryId: text('delivery_id').primaryKey(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const executions = pgTable(
  'executions',
  {
    executionId: text('execution_id').primaryKey(),
    repoFullName: text('repo_full_name').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha'),
    author: text('author'),
    title: text('title'),
    orgId: text('org_id'),
    status: text('status').notNull().default('pending'),
    riskScore: real('risk_score'),
    confidence: real('confidence'),
    findings: jsonb('findings').$type<unknown[]>(),
    s3Key: text('s3_key'),
    checkpoints: jsonb('checkpoints').$type<Record<string, unknown>>(),
    signalsReceived: jsonb('signals_received').$type<Record<string, unknown>>(),
    repoContext: jsonb('repo_context').$type<Record<string, unknown>>(),
    deploymentStartedAt: text('deployment_started_at'),
    deploymentCompletedAt: text('deployment_completed_at'),
    deploymentStrategy: text('deployment_strategy'),
    overrideHistory: jsonb('override_history').$type<unknown[]>(),
    contextVersion: integer('context_version'),
    agentType: text('agent_type'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ttl: integer('ttl'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_executions_repo').on(table.repoFullName),
    index('idx_executions_repo_pr').on(table.repoFullName, table.prNumber),
    index('idx_executions_created_at').on(table.createdAt),
    index('idx_executions_status_deployed').on(table.status, table.deploymentStartedAt),
  ]
);

export const llmRateLimits = pgTable('llm_rate_limits', {
  id: text('id').primaryKey(),
  counter: integer('counter').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const llmCache = pgTable('llm_cache', {
  cacheKey: text('cache_key').primaryKey(),
  findings: jsonb('findings').$type<unknown[]>(),
  riskScore: real('risk_score'),
  contextQuality: text('context_quality'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const fileKnowledge = pgTable(
  'file_knowledge',
  {
    id: text('id').primaryKey(),
    repoFullName: text('repo_full_name').notNull(),
    filePath: text('file_path').notNull(),
    changeFrequency: integer('change_frequency'),
    lastModifiedBy: text('last_modified_by'),
    lastModifiedAt: text('last_modified_at'),
    avgChangesPerMonth: real('avg_changes_per_month'),
    contributorCount: integer('contributor_count'),
    riskHistory: jsonb('risk_history').$type<unknown[]>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_file_knowledge_repo').on(table.repoFullName)]
);

export const authorProfiles = pgTable(
  'author_profiles',
  {
    id: text('id').primaryKey(),
    repoFullName: text('repo_full_name').notNull(),
    author: text('author').notNull(),
    totalCommits: integer('total_commits'),
    totalFilesChanged: integer('total_files_changed'),
    avgFilesPerCommit: real('avg_files_per_commit'),
    topFiles: jsonb('top_files').$type<string[]>(),
    rollbackRate: real('rollback_rate'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_author_profiles_repo').on(table.repoFullName)]
);

export const repoRegistry = pgTable('repo_registry', {
  repoFullName: text('repo_full_name').primaryKey(),
  installedAt: text('installed_at'),
  indexingStatus: text('indexing_status'),
  lastIndexedAt: text('last_indexed_at'),
  contextVersion: integer('context_version'),
  pendingBatches: integer('pending_batches'),
  moduleCount: integer('module_count'),
  fileCount: integer('file_count'),
  isSharedDependency: boolean('is_shared_dependency'),
  downstreamDependentCount: integer('downstream_dependent_count'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const moduleNarratives = pgTable(
  'module_narratives',
  {
    id: text('id').primaryKey(),
    repoFullName: text('repo_full_name').notNull(),
    modulePath: text('module_path').notNull(),
    narrative: text('narrative'),
    embedding: vector('embedding', { dimensions: 1536 }),
    contextVersion: integer('context_version'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('idx_module_narratives_repo').on(table.repoFullName)]
);

export const calibrations = pgTable('calibrations', {
  repoFullName: text('repo_full_name').primaryKey(),
  observationsCount: integer('observations_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  rollbackCount: integer('rollback_count').notNull().default(0),
  falsePositiveCount: integer('false_positive_count').notNull().default(0),
  falseNegativeCount: integer('false_negative_count').notNull().default(0),
  calibrationFactor: real('calibration_factor').notNull().default(1.0),
  lastUpdatedAt: text('last_updated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  signalWeights: jsonb('signal_weights').$type<SignalWeights | null>(),
  outcomeLog: jsonb('outcome_log')
    .$type<OutcomeLogEntry[]>()
    .default(sql`'[]'::jsonb`),
});

export const signalWeightDefaults = pgTable('signal_weight_defaults', {
  id: text('id').primaryKey().default('global'),
  weights: jsonb('weights').notNull().$type<SignalWeights>(),
  observationsCount: integer('observations_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const dependencyGraphs = pgTable(
  'dependency_graphs',
  {
    id: text('id').primaryKey(),
    upstreamRepo: text('upstream_repo').notNull(),
    downstreamRepo: text('downstream_repo').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [
    index('idx_dep_graph_upstream').on(table.upstreamRepo),
    index('idx_dep_graph_downstream').on(table.downstreamRepo),
  ]
);

export const tokenUsage = pgTable(
  'token_usage',
  {
    id: serial('id').primaryKey(),
    executionId: text('execution_id').references(() => executions.executionId),
    repoFullName: text('repo_full_name').notNull(),
    agentType: text('agent_type').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    estimatedCostUsd: real('estimated_cost_usd').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_token_usage_repo').on(table.repoFullName),
    index('idx_token_usage_created_at').on(table.createdAt),
    index('idx_token_usage_repo_created').on(table.repoFullName, table.createdAt),
    index('idx_token_usage_execution').on(table.executionId),
  ]
);
