CREATE TABLE "signal_weight_defaults" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"weights" jsonb NOT NULL,
	"observations_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "calibrations" ADD COLUMN "signal_weights" jsonb;--> statement-breakpoint
ALTER TABLE "calibrations" ADD COLUMN "outcome_log" jsonb DEFAULT '[]'::jsonb;