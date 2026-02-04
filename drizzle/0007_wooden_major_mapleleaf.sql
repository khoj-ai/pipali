-- Add web_search_provider table

-- Create type if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'web_search_provider_type') THEN
        CREATE TYPE "public"."web_search_provider_type" AS ENUM('exa', 'serper');
    END IF;
END $$;
--> statement-breakpoint

-- Create table if not exists
CREATE TABLE IF NOT EXISTS "web_search_provider" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "web_search_provider_type" NOT NULL,
	"api_key" text,
	"api_base_url" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
