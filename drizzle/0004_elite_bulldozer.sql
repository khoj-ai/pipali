CREATE TYPE "public"."mcp_transport_type" AS ENUM('stdio', 'sse');--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE "mcp_server" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "transport_type" "mcp_transport_type" NOT NULL,
    "path" text NOT NULL,
    "api_key" text,
    "env" jsonb,
    "requires_confirmation" boolean DEFAULT true NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "last_connected_at" timestamp,
    "last_error" text,
    "enabled_tools" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "mcp_server_name_unique" UNIQUE("name")
);
