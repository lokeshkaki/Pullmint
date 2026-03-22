CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "author_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"author" text NOT NULL,
	"total_commits" integer,
	"total_files_changed" integer,
	"avg_files_per_commit" real,
	"top_files" jsonb,
	"rollback_rate" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibrations" (
	"repo_full_name" text PRIMARY KEY NOT NULL,
	"observations_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"rollback_count" integer DEFAULT 0 NOT NULL,
	"false_positive_count" integer DEFAULT 0 NOT NULL,
	"false_negative_count" integer DEFAULT 0 NOT NULL,
	"calibration_factor" real DEFAULT 1 NOT NULL,
	"last_updated_at" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependency_graphs" (
	"id" text PRIMARY KEY NOT NULL,
	"upstream_repo" text NOT NULL,
	"downstream_repo" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"author" text,
	"title" text,
	"org_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"risk_score" real,
	"confidence" real,
	"findings" jsonb,
	"s3_key" text,
	"checkpoints" jsonb,
	"signals_received" jsonb,
	"repo_context" jsonb,
	"deployment_started_at" text,
	"deployment_completed_at" text,
	"deployment_strategy" text,
	"override_history" jsonb,
	"context_version" integer,
	"agent_type" text,
	"metadata" jsonb,
	"ttl" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"file_path" text NOT NULL,
	"change_frequency" integer,
	"last_modified_by" text,
	"last_modified_at" text,
	"avg_changes_per_month" real,
	"contributor_count" integer,
	"risk_history" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"findings" jsonb,
	"risk_score" real,
	"context_quality" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_narratives" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"module_path" text NOT NULL,
	"narrative" text,
	"embedding" vector(1536),
	"context_version" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_registry" (
	"repo_full_name" text PRIMARY KEY NOT NULL,
	"installed_at" text,
	"indexing_status" text,
	"last_indexed_at" text,
	"context_version" integer,
	"pending_batches" integer,
	"module_count" integer,
	"file_count" integer,
	"is_shared_dependency" boolean,
	"downstream_dependent_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_dedup" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_author_profiles_repo" ON "author_profiles" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_dep_graph_upstream" ON "dependency_graphs" USING btree ("upstream_repo");--> statement-breakpoint
CREATE INDEX "idx_dep_graph_downstream" ON "dependency_graphs" USING btree ("downstream_repo");--> statement-breakpoint
CREATE INDEX "idx_executions_repo" ON "executions" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_executions_repo_pr" ON "executions" USING btree ("repo_full_name","pr_number");--> statement-breakpoint
CREATE INDEX "idx_executions_created_at" ON "executions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_executions_status_deployed" ON "executions" USING btree ("status","deployment_started_at");--> statement-breakpoint
CREATE INDEX "idx_file_knowledge_repo" ON "file_knowledge" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_module_narratives_repo" ON "module_narratives" USING btree ("repo_full_name");