-- Make trigger_type and trigger_config nullable for manual-only automations
ALTER TABLE "automation" ALTER COLUMN "trigger_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation" ALTER COLUMN "trigger_config" DROP NOT NULL;
