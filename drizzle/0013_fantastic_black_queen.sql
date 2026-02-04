-- Add chat_model_id to conversation

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'chat_model_id') THEN
        ALTER TABLE "conversation" ADD COLUMN "chat_model_id" integer;
    END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_chat_model_id_chat_model_id_fk') THEN
        ALTER TABLE "conversation" ADD CONSTRAINT "conversation_chat_model_id_chat_model_id_fk" FOREIGN KEY ("chat_model_id") REFERENCES "public"."chat_model"("id") ON DELETE no action ON UPDATE no action;
    END IF;
END $$;
