-- Add platform_auth table and platform enum values

-- Create table if not exists
CREATE TABLE IF NOT EXISTS "platform_auth" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp,
	"platform_user_id" text,
	"platform_email" text,
	"platform_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add foreign key constraint if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_auth_user_id_user_id_fk') THEN
        ALTER TABLE "platform_auth" ADD CONSTRAINT "platform_auth_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint

-- Add platform value to web_search_provider_type if not exists (already idempotent)
ALTER TYPE "web_search_provider_type" ADD VALUE IF NOT EXISTS 'platform';
--> statement-breakpoint
-- Add platform value to web_scraper_type if not exists (already idempotent)
ALTER TYPE "web_scraper_type" ADD VALUE IF NOT EXISTS 'platform';
