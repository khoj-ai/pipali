-- Add automation system tables

-- Create types if not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trigger_type') THEN
        CREATE TYPE "public"."trigger_type" AS ENUM('cron', 'file_watch');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_status') THEN
        CREATE TYPE "public"."automation_status" AS ENUM('active', 'paused', 'disabled');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'execution_status') THEN
        CREATE TYPE "public"."execution_status" AS ENUM('pending', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'confirmation_status') THEN
        CREATE TYPE "public"."confirmation_status" AS ENUM('pending', 'approved', 'denied', 'expired');
    END IF;
END $$;
--> statement-breakpoint

-- Create tables if not exist
CREATE TABLE IF NOT EXISTS "automation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt" text NOT NULL,
	"trigger_type" "trigger_type" NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"status" "automation_status" DEFAULT 'active' NOT NULL,
	"max_iterations" integer DEFAULT 15 NOT NULL,
	"max_executions_per_day" integer,
	"max_executions_per_hour" integer,
	"last_executed_at" timestamp,
	"next_scheduled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"trigger_data" jsonb,
	"trajectory" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_confirmation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"status" "confirmation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add foreign key constraints if not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_user_id_user_id_fk') THEN
        ALTER TABLE "automation" ADD CONSTRAINT "automation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_execution_automation_id_automation_id_fk') THEN
        ALTER TABLE "automation_execution" ADD CONSTRAINT "automation_execution_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_confirmation_execution_id_automation_execution_id_fk') THEN
        ALTER TABLE "pending_confirmation" ADD CONSTRAINT "pending_confirmation_execution_id_automation_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."automation_execution"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint

-- Create indexes if not exist
CREATE INDEX IF NOT EXISTS "automation_user_id_idx" ON "automation" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_status_idx" ON "automation" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_execution_automation_id_idx" ON "automation_execution" USING btree ("automation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_execution_status_idx" ON "automation_execution" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_confirmation_execution_id_idx" ON "pending_confirmation" USING btree ("execution_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_confirmation_status_idx" ON "pending_confirmation" USING btree ("status");
