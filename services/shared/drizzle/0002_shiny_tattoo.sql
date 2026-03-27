CREATE TABLE "token_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"execution_id" text,
	"repo_full_name" text NOT NULL,
	"agent_type" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost_usd" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_token_usage_repo" ON "token_usage" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX "idx_token_usage_created_at" ON "token_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_token_usage_repo_created" ON "token_usage" USING btree ("repo_full_name","created_at");--> statement-breakpoint
CREATE INDEX "idx_token_usage_execution" ON "token_usage" USING btree ("execution_id");