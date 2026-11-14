-- Hand-adjusted (tailnet-hosting decision 9): a token row created before
-- scopes existed becomes `human`, the scope it effectively had, through a
-- one-time default that is dropped at once, so every new row must state
-- its scope. The snapshot records the end state (NOT NULL, no default).
ALTER TABLE "client_tokens" ADD COLUMN "scope" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_tokens" ALTER COLUMN "scope" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "client_tokens" ADD CONSTRAINT "client_tokens_scope_check" CHECK ("client_tokens"."scope" IN ('human', 'agent'));
