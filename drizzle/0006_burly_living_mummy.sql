ALTER TABLE "chat_model" ADD COLUMN "input_cost_per_million" real;--> statement-breakpoint
ALTER TABLE "chat_model" ADD COLUMN "output_cost_per_million" real;--> statement-breakpoint
ALTER TABLE "chat_model" ADD COLUMN "cache_read_cost_per_million" real;--> statement-breakpoint
ALTER TABLE "chat_model" ADD COLUMN "cache_write_cost_per_million" real;