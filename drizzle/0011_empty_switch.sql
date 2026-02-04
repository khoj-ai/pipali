-- Remove max_iterations column from automation

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'automation' AND column_name = 'max_iterations') THEN
        ALTER TABLE "automation" DROP COLUMN "max_iterations";
    END IF;
END $$;
