-- Add web_scraper table and clean up conversation columns

-- Create type if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'web_scraper_type') THEN
        CREATE TYPE "public"."web_scraper_type" AS ENUM('exa', 'direct');
    END IF;
END $$;
--> statement-breakpoint

-- Create table if not exists
CREATE TABLE IF NOT EXISTS "web_scraper" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "web_scraper_type" NOT NULL,
	"api_key" text,
	"api_base_url" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Drop constraint only if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_agent_id_agents_id_fk') THEN
        ALTER TABLE "conversation" DROP CONSTRAINT "conversation_agent_id_agents_id_fk";
    END IF;
END $$;
--> statement-breakpoint

-- Drop columns only if they exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'slug') THEN
        ALTER TABLE "conversation" DROP COLUMN "slug";
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'agent_id') THEN
        ALTER TABLE "conversation" DROP COLUMN "agent_id";
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'file_filters') THEN
        ALTER TABLE "conversation" DROP COLUMN "file_filters";
    END IF;
END $$;
