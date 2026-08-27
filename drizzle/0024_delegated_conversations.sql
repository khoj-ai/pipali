-- Delegated conversations.
--
-- conversation.parent_conversation_id is set when an agent delegated the conversation.
-- It doubles as the delegated marker (delegated <=> NOT NULL) and is what the hard-stop
-- cascade queries to find a conversation's children. Left unconstrained, like
-- conversation.automation_id, so deleting a parent leaves children usable on their own.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversation' AND column_name = 'parent_conversation_id') THEN
        ALTER TABLE "conversation" ADD COLUMN "parent_conversation_id" uuid;
    END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "conversation_parent_conversation_id_idx" ON "conversation" USING btree ("parent_conversation_id");
