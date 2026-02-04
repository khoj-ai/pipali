-- Add conversation support to automations
-- This allows automations to persist their execution history to a conversation,
-- giving the agent context across runs and allowing users to view/interact with automation runs.

-- Add automation_id to conversation table only if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'automation_id') THEN
        ALTER TABLE "conversation" ADD COLUMN "automation_id" uuid;
    END IF;
END $$;
--> statement-breakpoint

-- Add conversation_id to automation table only if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automation' AND column_name = 'conversation_id') THEN
        ALTER TABLE "automation" ADD COLUMN "conversation_id" uuid;
    END IF;
END $$;
--> statement-breakpoint

-- Add foreign key constraint only if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_conversation_id_conversation_id_fk') THEN
        ALTER TABLE "automation" ADD CONSTRAINT "automation_conversation_id_conversation_id_fk"
            FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;
