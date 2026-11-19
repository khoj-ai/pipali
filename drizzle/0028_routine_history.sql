CREATE TYPE "public"."routine_history_mode" AS ENUM('all', 'summarized', 'fresh');--> statement-breakpoint
-- Routines that exist already keep every earlier run; only new ones start summarized
ALTER TABLE "automation" ADD COLUMN "history_mode" "routine_history_mode" DEFAULT 'all' NOT NULL;--> statement-breakpoint
-- Except the memory dream, which needs none of its earlier passes. Its id is the only name-based (version 5) uuid
UPDATE "automation" SET "history_mode" = 'fresh' WHERE uuid_extract_version("id") = 5;--> statement-breakpoint
ALTER TABLE "automation" ALTER COLUMN "history_mode" SET DEFAULT 'summarized';--> statement-breakpoint
ALTER TABLE "automation" ADD COLUMN "history_runs" integer DEFAULT 3 NOT NULL;
