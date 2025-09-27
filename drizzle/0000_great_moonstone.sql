CREATE TYPE "public"."chat_model_type" AS ENUM('openai', 'anthropic', 'google');--> statement-breakpoint
CREATE TYPE "public"."input_tool" AS ENUM('general', 'online', 'notes', 'webpage', 'code');--> statement-breakpoint
CREATE TYPE "public"."output_mode" AS ENUM('image', 'diagram');--> statement-breakpoint
CREATE TYPE "public"."price_tier" AS ENUM('free', 'premium');--> statement-breakpoint
CREATE TYPE "public"."privacy_level" AS ENUM('public', 'private', 'protected');--> statement-breakpoint
CREATE TYPE "public"."speech_to_text_model_type" AS ENUM('openai', 'google');--> statement-breakpoint
CREATE TYPE "public"."style_color" AS ENUM('blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'teal', 'cyan', 'lime', 'indigo', 'fuchsia', 'rose', 'sky', 'amber', 'emerald');--> statement-breakpoint
CREATE TYPE "public"."style_icon" AS ENUM('Lightbulb', 'Health', 'Robot', 'Aperture', 'GraduationCap', 'Jeep', 'Island', 'MathOperations', 'Asclepius', 'Couch', 'Code', 'Atom', 'ClockCounterClockwise', 'PencilLine', 'Chalkboard', 'Cigarette', 'CraneTower', 'Heart', 'Leaf', 'NewspaperClipping', 'OrangeSlice', 'SmileyMelting', 'YinYang', 'SneakerMove', 'Student', 'Oven', 'Gavel', 'Broadcast');--> statement-breakpoint
CREATE TYPE "public"."subscription_type" AS ENUM('free', 'premium');--> statement-breakpoint
CREATE TYPE "public"."text_to_image_model_type" AS ENUM('openai', 'replicate', 'google');--> statement-breakpoint
CREATE TABLE "agents" (
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
CREATE TABLE "ai_model_apis" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key" text NOT NULL,
	"api_base_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"accessed_at" timestamp,
	CONSTRAINT "api_keys_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "chat_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"max_prompt_size" integer,
	"subscribed_max_prompt_size" integer,
	"tokenizer" text,
	"name" text DEFAULT 'gemini-2.5-flash' NOT NULL,
	"friendly_name" text,
	"model_type" "chat_model_type" DEFAULT 'google' NOT NULL,
	"price_tier" "price_tier" DEFAULT 'free' NOT NULL,
	"vision_enabled" boolean DEFAULT false NOT NULL,
	"ai_model_api_id" integer,
	"description" text,
	"strengths" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"conversation_log" jsonb DEFAULT '{"chat":[]}'::jsonb,
	"slug" text,
	"title" text,
	"agent_id" integer,
	"file_filters" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_users" (
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
CREATE TABLE "rate_limit_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_to_text_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text DEFAULT 'whisper-1' NOT NULL,
	"friendly_name" text,
	"model_type" "speech_to_text_model_type" DEFAULT 'openai' NOT NULL,
	"price_tier" "price_tier" DEFAULT 'free' NOT NULL,
	"ai_model_api_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "subscription_type" DEFAULT 'free' NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"renewal_date" timestamp,
	"enabled_trial_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "text_to_image_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text DEFAULT 'imagen-4.0-generate-001' NOT NULL,
	"friendly_name" text,
	"model_type" text_to_image_model_type DEFAULT 'openai' NOT NULL,
	"price_tier" "price_tier" DEFAULT 'free' NOT NULL,
	"api_key" text,
	"ai_model_api_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_to_speech_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"price_tier" "price_tier" DEFAULT 'free' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_chat_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"model_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_speech_to_text_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"model_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_text_to_image_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"model_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_text_to_speech_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"model_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
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
	CONSTRAINT "users_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_chat_model_id_chat_models_id_fk" FOREIGN KEY ("chat_model_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_models" ADD CONSTRAINT "chat_models_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_users" ADD CONSTRAINT "google_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_to_text_models" ADD CONSTRAINT "speech_to_text_models_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_to_image_models" ADD CONSTRAINT "text_to_image_models_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_model" ADD CONSTRAINT "user_chat_model_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_model" ADD CONSTRAINT "user_chat_model_model_id_chat_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_requests" ADD CONSTRAINT "user_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_speech_to_text_model" ADD CONSTRAINT "user_speech_to_text_model_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_speech_to_text_model" ADD CONSTRAINT "user_speech_to_text_model_model_id_speech_to_text_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."speech_to_text_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_image_model" ADD CONSTRAINT "user_text_to_image_model_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_image_model" ADD CONSTRAINT "user_text_to_image_model_model_id_text_to_image_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."text_to_image_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_speech_model" ADD CONSTRAINT "user_text_to_speech_model_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_speech_model" ADD CONSTRAINT "user_text_to_speech_model_model_id_text_to_speech_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."text_to_speech_models"("id") ON DELETE cascade ON UPDATE no action;