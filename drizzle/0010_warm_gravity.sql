CREATE TABLE "sandbox_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_write_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_write_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_read_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_domains" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"allow_local_binding" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "sandbox_settings" ADD CONSTRAINT "sandbox_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;