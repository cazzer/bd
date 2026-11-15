CREATE TABLE "relay_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"requested_by" text,
	"origin_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_actions_kind_check" CHECK ("relay_actions"."kind" IN ('review_decision', 'herdr_prompt', 'beads_reingest')),
	CONSTRAINT "relay_actions_state_check" CHECK ("relay_actions"."state" IN ('queued', 'claimed', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "relay_check_ins" (
	"relay" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text,
	"interval_s" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_tokens" DROP CONSTRAINT "client_tokens_scope_check";--> statement-breakpoint
CREATE INDEX "relay_actions_open_idx" ON "relay_actions" USING btree ("created_at","id") WHERE "relay_actions"."state" IN ('queued', 'claimed');--> statement-breakpoint
CREATE UNIQUE INDEX "relay_actions_open_target_idx" ON "relay_actions" USING btree ("kind",("payload"->>'project_key'),coalesce("payload"->>'issue_id', '')) WHERE "relay_actions"."state" IN ('queued', 'claimed') AND "relay_actions"."kind" <> 'herdr_prompt';--> statement-breakpoint
ALTER TABLE "client_tokens" ADD CONSTRAINT "client_tokens_scope_check" CHECK ("client_tokens"."scope" IN ('human', 'agent', 'hangar', 'relay'));