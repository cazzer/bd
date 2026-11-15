CREATE TABLE "hangar_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"pr_url" text,
	"card" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"escalation" jsonb,
	"decision" jsonb,
	"filed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hangar_decisions_kind_check" CHECK ("hangar_decisions"."kind" IN ('pr', 'question')),
	CONSTRAINT "hangar_decisions_state_check" CHECK ("hangar_decisions"."state" IN ('pending', 'decided', 'escalated', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "relay_actions" DROP CONSTRAINT "relay_actions_kind_check";--> statement-breakpoint
CREATE INDEX "hangar_decisions_session_idx" ON "hangar_decisions" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "hangar_decisions_open_idx" ON "hangar_decisions" USING btree ("session_id") WHERE "hangar_decisions"."state" IN ('pending', 'escalated');--> statement-breakpoint
ALTER TABLE "relay_actions" ADD CONSTRAINT "relay_actions_kind_check" CHECK ("relay_actions"."kind" IN ('review_decision', 'herdr_prompt', 'beads_reingest', 'review_request'));