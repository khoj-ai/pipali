-- Make trigger_type and trigger_config nullable for manual-only automations

-- Only alter if column exists and is still not null
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automation' AND column_name = 'trigger_type' AND is_nullable = 'NO') THEN
        ALTER TABLE "automation" ALTER COLUMN "trigger_type" DROP NOT NULL;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automation' AND column_name = 'trigger_config' AND is_nullable = 'NO') THEN
        ALTER TABLE "automation" ALTER COLUMN "trigger_config" DROP NOT NULL;
    END IF;
END $$;
