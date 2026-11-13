CREATE TABLE "client_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "client_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "client_tokens_live_client_idx" ON "client_tokens" USING btree ("client") WHERE "client_tokens"."revoked_at" IS NULL;