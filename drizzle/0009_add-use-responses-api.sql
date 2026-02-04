-- Add use_responses_api column to chat_model

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_model' AND column_name = 'use_responses_api') THEN
        ALTER TABLE "chat_model" ADD COLUMN "use_responses_api" boolean DEFAULT false NOT NULL;
    END IF;
END $$;
