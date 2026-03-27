CREATE TABLE "notification_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel_type" text NOT NULL,
	"webhook_url" text NOT NULL,
	"repo_filter" text,
	"events" jsonb NOT NULL,
	"min_risk_score" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_notification_channels_enabled" ON "notification_channels" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_notification_channels_type" ON "notification_channels" USING btree ("channel_type");