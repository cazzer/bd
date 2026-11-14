CREATE TABLE "hangar_check_ins" (
	"hangar" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text,
	"capacity" jsonb,
	"interval_s" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hangar_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_tokens" DROP CONSTRAINT "client_tokens_scope_check";--> statement-breakpoint
ALTER TABLE "client_tokens" ADD COLUMN "session_id" uuid;--> statement-breakpoint
CREATE INDEX "hangar_messages_session_id_id_idx" ON "hangar_messages" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "client_tokens_session_id_idx" ON "client_tokens" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "client_tokens" ADD CONSTRAINT "client_tokens_session_scope_check" CHECK ("client_tokens"."session_id" IS NULL OR "client_tokens"."scope" = 'agent');--> statement-breakpoint
ALTER TABLE "client_tokens" ADD CONSTRAINT "client_tokens_scope_check" CHECK ("client_tokens"."scope" IN ('human', 'agent', 'hangar'));