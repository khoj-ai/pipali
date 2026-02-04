-- Add cost tracking columns to chat_model

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_model' AND column_name = 'input_cost_per_million') THEN
        ALTER TABLE "chat_model" ADD COLUMN "input_cost_per_million" real;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_model' AND column_name = 'output_cost_per_million') THEN
        ALTER TABLE "chat_model" ADD COLUMN "output_cost_per_million" real;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_model' AND column_name = 'cache_read_cost_per_million') THEN
        ALTER TABLE "chat_model" ADD COLUMN "cache_read_cost_per_million" real;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_model' AND column_name = 'cache_write_cost_per_million') THEN
        ALTER TABLE "chat_model" ADD COLUMN "cache_write_cost_per_million" real;
    END IF;
END $$;
