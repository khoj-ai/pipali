-- Add confirmation mode enum for MCP servers
-- Replaces the boolean requires_confirmation with a 3-way setting:
-- - 'always': Always require confirmation (default, most restrictive)
-- - 'unsafe_only': Only require confirmation for unsafe operations (those with lasting side effects)
-- - 'never': Never require confirmation (least restrictive)

CREATE TYPE "public"."mcp_confirmation_mode" AS ENUM('always', 'unsafe_only', 'never');
--> statement-breakpoint

-- Add new column with default 'always' (maps to previous requires_confirmation=true behavior)
ALTER TABLE "mcp_server" ADD COLUMN "confirmation_mode" "mcp_confirmation_mode" DEFAULT 'always' NOT NULL;
--> statement-breakpoint

-- Migrate existing data: requires_confirmation=true -> 'always', requires_confirmation=false -> 'never'
UPDATE "mcp_server" SET "confirmation_mode" = CASE
    WHEN "requires_confirmation" = true THEN 'always'::"mcp_confirmation_mode"
    ELSE 'never'::"mcp_confirmation_mode"
END;
--> statement-breakpoint

-- Drop the old column
ALTER TABLE "mcp_server" DROP COLUMN "requires_confirmation";
