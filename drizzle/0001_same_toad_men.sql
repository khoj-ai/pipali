CREATE TYPE "public"."chat_model_type" AS ENUM('openai', 'anthropic', 'google');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('computer', 'notion', 'github');--> statement-breakpoint
CREATE TYPE "public"."entry_type" AS ENUM('image', 'pdf', 'plaintext', 'markdown', 'org', 'notion', 'github', 'conversation', 'docx');--> statement-breakpoint
CREATE TYPE "public"."input_tool" AS ENUM('general', 'online', 'notes', 'webpage', 'code');--> statement-breakpoint
CREATE TYPE "public"."output_mode" AS ENUM('image', 'diagram');--> statement-breakpoint
CREATE TYPE "public"."price_tier" AS ENUM('free', 'standard');--> statement-breakpoint
CREATE TYPE "public"."privacy_level" AS ENUM('public', 'private', 'protected');--> statement-breakpoint
CREATE TYPE "public"."process_lock_operation" AS ENUM('index_content', 'scheduled_job', 'schedule_leader', 'apply_migrations');--> statement-breakpoint
CREATE TYPE "public"."search_model_api_type" AS ENUM('huggingface', 'openai', 'local');--> statement-breakpoint
CREATE TYPE "public"."search_model_type" AS ENUM('text');--> statement-breakpoint
CREATE TYPE "public"."speech_to_text_model_type" AS ENUM('openai');--> statement-breakpoint
CREATE TYPE "public"."style_color" AS ENUM('blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'teal', 'cyan', 'lime', 'indigo', 'fuchsia', 'rose', 'sky', 'amber', 'emerald');--> statement-breakpoint
CREATE TYPE "public"."style_icon" AS ENUM('Lightbulb', 'Health', 'Robot', 'Aperture', 'GraduationCap', 'Jeep', 'Island', 'MathOperations', 'Asclepius', 'Couch', 'Code', 'Atom', 'ClockCounterClockwise', 'PencilLine', 'Chalkboard', 'Cigarette', 'CraneTower', 'Heart', 'Leaf', 'NewspaperClipping', 'OrangeSlice', 'SmileyMelting', 'YinYang', 'SneakerMove', 'Student', 'Oven', 'Gavel', 'Broadcast');--> statement-breakpoint
CREATE TYPE "public"."subscription_type" AS ENUM('trial', 'standard');--> statement-breakpoint
CREATE TYPE "public"."text_to_image_model_type" AS ENUM('openai', 'stability-ai', 'replicate', 'google');--> statement-breakpoint
CREATE TYPE "public"."web_scraper_type" AS ENUM('Firecrawl', 'Olostep', 'Jina', 'Direct');--> statement-breakpoint
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
CREATE TABLE "client_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"conversation_log" jsonb DEFAULT '{}'::jsonb,
	"client_id" integer,
	"slug" text,
	"title" text,
	"agent_id" integer,
	"file_filters" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb,
	"private" boolean DEFAULT false NOT NULL,
	"owner_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_stores_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"agent_id" integer,
	"embeddings" jsonb,
	"raw" text NOT NULL,
	"compiled" text NOT NULL,
	"heading" text,
	"file_source" "entry_source" DEFAULT 'computer' NOT NULL,
	"file_type" "entry_type" DEFAULT 'plaintext' NOT NULL,
	"file_path" text,
	"file_name" text,
	"url" text,
	"hashed_value" text NOT NULL,
	"corpus_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"search_model_id" integer,
	"file_object_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_dates" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"entry_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_objects" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text,
	"raw_text" text NOT NULL,
	"user_id" integer,
	"agent_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"pat_token" text NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repo_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"branch" text NOT NULL,
	"github_config_id" integer NOT NULL,
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
CREATE TABLE "khoj_api_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"accessed_at" timestamp,
	CONSTRAINT "khoj_api_users_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "khoj_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"password" text,
	"last_login" timestamp,
	"is_superuser" boolean DEFAULT false NOT NULL,
	"username" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"is_staff" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"date_joined" timestamp DEFAULT now() NOT NULL,
	"phone_number" text,
	"verified_phone_number" boolean DEFAULT false NOT NULL,
	"verified_email" boolean DEFAULT false NOT NULL,
	"email_verification_code" text,
	"email_verification_code_expiry" timestamp,
	CONSTRAINT "khoj_users_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "khoj_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "local_markdown_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"input_files" jsonb DEFAULT '[]'::jsonb,
	"input_filter" jsonb DEFAULT '[]'::jsonb,
	"index_heading_entries" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_org_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"input_files" jsonb DEFAULT '[]'::jsonb,
	"input_filter" jsonb DEFAULT '[]'::jsonb,
	"index_heading_entries" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_pdf_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"input_files" jsonb DEFAULT '[]'::jsonb,
	"input_filter" jsonb DEFAULT '[]'::jsonb,
	"index_heading_entries" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_plaintext_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"input_files" jsonb DEFAULT '[]'::jsonb,
	"input_filter" jsonb DEFAULT '[]'::jsonb,
	"index_heading_entries" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" "process_lock_operation" NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"max_duration_in_seconds" integer DEFAULT 43200 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "process_locks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "public_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_owner_id" integer NOT NULL,
	"conversation_log" jsonb DEFAULT '{}'::jsonb,
	"slug" text,
	"title" text,
	"agent_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "reflective_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_model_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"model_type" "search_model_type" DEFAULT 'text' NOT NULL,
	"bi_encoder" text DEFAULT 'thenlper/gte-small' NOT NULL,
	"bi_encoder_model_config" jsonb DEFAULT '{}'::jsonb,
	"bi_encoder_query_encode_config" jsonb DEFAULT '{}'::jsonb,
	"bi_encoder_docs_encode_config" jsonb DEFAULT '{}'::jsonb,
	"cross_encoder" text DEFAULT 'mixedbread-ai/mxbai-rerank-xsmall-v1' NOT NULL,
	"cross_encoder_model_config" jsonb DEFAULT '{}'::jsonb,
	"embeddings_inference_endpoint" text,
	"embeddings_inference_endpoint_api_key" text,
	"embeddings_inference_endpoint_type" "search_model_api_type" DEFAULT 'local' NOT NULL,
	"cross_encoder_inference_endpoint" text,
	"cross_encoder_inference_endpoint_api_key" text,
	"bi_encoder_confidence_threshold" real DEFAULT 0.18 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_chat_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_default_id" integer,
	"chat_advanced_id" integer,
	"web_scraper_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_to_text_model_options" (
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
	"type" "subscription_type" DEFAULT 'standard' NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"renewal_date" timestamp,
	"enabled_trial_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_to_image_model_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text DEFAULT 'dall-e-3' NOT NULL,
	"friendly_name" text,
	"model_type" text_to_image_model_type DEFAULT 'openai' NOT NULL,
	"price_tier" "price_tier" DEFAULT 'free' NOT NULL,
	"api_key" text,
	"ai_model_api_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_conversation_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"setting_id" integer,
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
CREATE TABLE "user_text_to_image_model_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"setting_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_voice_model_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"setting_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_model_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"price_tier" "price_tier" DEFAULT 'standard' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_scrapers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"type" "web_scraper_type" DEFAULT 'Jina' NOT NULL,
	"api_key" text,
	"api_url" text,
	"priority" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "web_scrapers_name_unique" UNIQUE("name"),
	CONSTRAINT "web_scrapers_priority_unique" UNIQUE("priority")
);
--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_id_khoj_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_chat_model_id_chat_models_id_fk" FOREIGN KEY ("chat_model_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_models" ADD CONSTRAINT "chat_models_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_client_applications_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_stores" ADD CONSTRAINT "data_stores_owner_id_khoj_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_search_model_id_search_model_configs_id_fk" FOREIGN KEY ("search_model_id") REFERENCES "public"."search_model_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_file_object_id_file_objects_id_fk" FOREIGN KEY ("file_object_id") REFERENCES "public"."file_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_dates" ADD CONSTRAINT "entry_dates_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_configs" ADD CONSTRAINT "github_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_configs" ADD CONSTRAINT "github_repo_configs_github_config_id_github_configs_id_fk" FOREIGN KEY ("github_config_id") REFERENCES "public"."github_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_users" ADD CONSTRAINT "google_users_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "khoj_api_users" ADD CONSTRAINT "khoj_api_users_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_markdown_configs" ADD CONSTRAINT "local_markdown_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_org_configs" ADD CONSTRAINT "local_org_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_pdf_configs" ADD CONSTRAINT "local_pdf_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_plaintext_configs" ADD CONSTRAINT "local_plaintext_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notion_configs" ADD CONSTRAINT "notion_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_conversations" ADD CONSTRAINT "public_conversations_source_owner_id_khoj_users_id_fk" FOREIGN KEY ("source_owner_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_conversations" ADD CONSTRAINT "public_conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflective_questions" ADD CONSTRAINT "reflective_questions_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_chat_settings" ADD CONSTRAINT "server_chat_settings_chat_default_id_chat_models_id_fk" FOREIGN KEY ("chat_default_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_chat_settings" ADD CONSTRAINT "server_chat_settings_chat_advanced_id_chat_models_id_fk" FOREIGN KEY ("chat_advanced_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_chat_settings" ADD CONSTRAINT "server_chat_settings_web_scraper_id_web_scrapers_id_fk" FOREIGN KEY ("web_scraper_id") REFERENCES "public"."web_scrapers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_to_text_model_options" ADD CONSTRAINT "speech_to_text_model_options_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_to_image_model_configs" ADD CONSTRAINT "text_to_image_model_configs_ai_model_api_id_ai_model_apis_id_fk" FOREIGN KEY ("ai_model_api_id") REFERENCES "public"."ai_model_apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_conversation_configs" ADD CONSTRAINT "user_conversation_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_conversation_configs" ADD CONSTRAINT "user_conversation_configs_setting_id_chat_models_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."chat_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_requests" ADD CONSTRAINT "user_requests_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_image_model_configs" ADD CONSTRAINT "user_text_to_image_model_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_text_to_image_model_configs" ADD CONSTRAINT "user_text_to_image_model_configs_setting_id_text_to_image_model_configs_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."text_to_image_model_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_voice_model_configs" ADD CONSTRAINT "user_voice_model_configs_user_id_khoj_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."khoj_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_voice_model_configs" ADD CONSTRAINT "user_voice_model_configs_setting_id_voice_model_options_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."voice_model_options"("id") ON DELETE cascade ON UPDATE no action;
