ALTER TABLE "hangar_check_ins" ADD COLUMN "capacity_at" timestamp with time zone;--> statement-breakpoint
-- Rows from before capacity_at: the last check-in is the best guess at when the stored capacity arrived; the next check-in corrects it.
UPDATE "hangar_check_ins" SET "capacity_at" = "last_seen_at" WHERE "capacity" IS NOT NULL;
