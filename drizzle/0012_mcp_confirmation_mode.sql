-- Add confirmation mode enum for MCP servers
-- Replaces the boolean requires_confirmation with a 3-way setting:
-- - 'always': Always require confirmation (default, most restrictive)
-- - 'unsafe_only': Only require confirmation for unsafe operations (those with lasting side effects)
-- - 'never': Never require confirmation (least restrictive)

-- Create type if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mcp_confirmation_mode') THEN
        CREATE TYPE "public"."mcp_confirmation_mode" AS ENUM('always', 'unsafe_only', 'never');
    END IF;
END $$;
--> statement-breakpoint

-- Add new column with default 'always' (maps to previous requires_confirmation=true behavior) if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mcp_server' AND column_name = 'confirmation_mode') THEN
        ALTER TABLE "mcp_server" ADD COLUMN "confirmation_mode" "mcp_confirmation_mode" DEFAULT 'always' NOT NULL;
    END IF;
END $$;
--> statement-breakpoint

-- Migrate existing data only if the old column still exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mcp_server' AND column_name = 'requires_confirmation') THEN
        UPDATE "mcp_server" SET "confirmation_mode" = CASE
            WHEN "requires_confirmation" = true THEN 'always'::"mcp_confirmation_mode"
            ELSE 'never'::"mcp_confirmation_mode"
        END;
    END IF;
END $$;
--> statement-breakpoint

-- Drop the old column only if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mcp_server' AND column_name = 'requires_confirmation') THEN
        ALTER TABLE "mcp_server" DROP COLUMN "requires_confirmation";
    END IF;
END $$;
