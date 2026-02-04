-- Initial schema creation
-- Types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_model_type') THEN
        CREATE TYPE "public"."chat_model_type" AS ENUM('openai', 'anthropic', 'google');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_type') THEN
        CREATE TYPE "public"."subscription_type" AS ENUM('free', 'premium');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'input_tool') THEN
        CREATE TYPE "public"."input_tool" AS ENUM('general', 'online', 'notes', 'webpage', 'code');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'output_mode') THEN
        CREATE TYPE "public"."output_mode" AS ENUM('image', 'diagram');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'privacy_level') THEN
        CREATE TYPE "public"."privacy_level" AS ENUM('public', 'private', 'protected');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'style_color') THEN
        CREATE TYPE "public"."style_color" AS ENUM('blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'teal', 'cyan', 'lime', 'indigo', 'fuchsia', 'rose', 'sky', 'amber', 'emerald');
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'style_icon') THEN
        CREATE TYPE "public"."style_icon" AS ENUM('Lightbulb', 'Health', 'Robot', 'Aperture', 'GraduationCap', 'Jeep', 'Island', 'MathOperations', 'Asclepius', 'Couch', 'Code', 'Atom', 'ClockCounterClockwise', 'PencilLine', 'Chalkboard', 'Cigarette', 'CraneTower', 'Heart', 'Leaf', 'NewspaperClipping', 'OrangeSlice', 'SmileyMelting', 'YinYang', 'SneakerMove', 'Student', 'Oven', 'Gavel', 'Broadcast');
    END IF;
END $$;
--> statement-breakpoint

-- Tables
CREATE TABLE IF NOT EXISTS "ai_model_api" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key" text NOT NULL,
	"api_base_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_key" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"accessed_at" timestamp,
	CONSTRAINT "api_key_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"max_prompt_size" integer,
	"tokenizer" text,
	"name" text DEFAULT 'gemini-2.5-flash' NOT NULL,
	"friendly_name" text,
	"model_type" "chat_model_type" DEFAULT 'google' NOT NULL,
	"vision_enabled" boolean DEFAULT false NOT NULL,
	"ai_model_api_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"trajectory" jsonb NOT NULL,
	"slug" text,
	"title" text,
	"agent_id" integer,
	"file_filters" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_user" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"sub" text NOT NULL,
	"azp" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"given_name" text,
	"family_name" text,
	"picture" text,
	"locale" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "subscription_type" DEFAULT 'free' NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"renewal_date" timestamp,
	"enabled_trial_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"password" text,
	"username" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone_number" text,
	"verified_phone_number" boolean DEFAULT false NOT NULL,
	"verified_email" boolean DEFAULT false NOT NULL,
	"account_verification_code" text,
	"account_verification_code_expiry" timestamp,
	"last_login" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_chat_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"model_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer,
	"name" text NOT NULL,
	"personality" text,
	"input_tools" "input_tool"[],
	"output_modes" "output_mode"[],
	"managed_by_admin" boolean DEFAULT false NOT NULL,
	"chat_model_id" integer NOT NULL,
	"slug" text NOT NULL,
	"style_color" "style_color" DEFAULT 'orange' NOT NULL,
	"style_icon" "style_icon" DEFAULT 'Lightbulb' NOT NULL,
	"privacy_level" "privacy_level" DEFAULT 'private' NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint

-- Foreign Keys
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_key_user_id_user_id_fk') THEN
        ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_model_ai_model_api_id_ai_model_api_id_fk') THEN
        ALTER TABLE "chat_model" ADD CONSTRAINT "chat_model_ai_model_api_id_ai_model_api_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_api"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_user_id_user_id_fk') THEN
        ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_agent_id_agents_id_fk') THEN
        ALTER TABLE "conversation" ADD CONSTRAINT "conversation_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'google_user_user_id_user_id_fk') THEN
        ALTER TABLE "google_user" ADD CONSTRAINT "google_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_user_id_user_id_fk') THEN
        ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_chat_model_user_id_user_id_fk') THEN
        ALTER TABLE "user_chat_model" ADD CONSTRAINT "user_chat_model_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_chat_model_model_id_chat_model_id_fk') THEN
        ALTER TABLE "user_chat_model" ADD CONSTRAINT "user_chat_model_model_id_chat_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."chat_model"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_creator_id_user_id_fk') THEN
        ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_chat_model_id_chat_model_id_fk') THEN
        ALTER TABLE "agents" ADD CONSTRAINT "agents_chat_model_id_chat_model_id_fk" FOREIGN KEY ("chat_model_id") REFERENCES "public"."chat_model"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;
