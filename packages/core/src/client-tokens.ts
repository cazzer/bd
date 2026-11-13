// Per-client tokens for requests from off the local machine (tailnet-hosting,
// design decision 3). A token is `bdt_` plus base64url of 32 random bytes;
// the table holds only its sha256, and the token itself is returned once by
// `createClientToken` for the host-side CLI to print. Nothing here logs a
// token, and no tRPC procedure or MCP tool calls the create, list, or revoke
// functions: only `verifyClientToken` is meant for the servers.
//
// Every token carries a scope, `human` or `agent` (design decision 9); the
// servers' admission policies decide which scopes each accepts.
//
// There is no in-process cache, so a revocation takes effect on the next
// request. `last_used_at` is touched at most once a minute per token, so
// steady traffic does not turn every read into a write.

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { CLIENT_TOKEN_SCOPES, clientTokens, type ClientTokenScope, type Database } from "@breakdown/db";
import { ClientTokenExistsError, ClientTokenNotFoundError, InvalidClientNameError } from "./errors.js";
import { asPgError } from "./sql-helpers.js";

export const CLIENT_TOKEN_PREFIX = "bdt_";
export const CLIENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Exactly what createClientToken mints: the prefix and 32 bytes of
// base64url (43 characters, unpadded). Anything else is refused before it
// costs a hash or a query.
const TOKEN_SHAPE = /^bdt_[A-Za-z0-9_-]{43}$/;

export interface VerifiedClientToken {
  client: string;
  scope: ClientTokenScope;
}

export interface CreatedClientToken {
  client: string;
  scope: ClientTokenScope;
  /** Shown once; only its hash is stored. */
  token: string;
  createdAt: Date;
}

export interface ClientTokenListing {
  client: string;
  scope: ClientTokenScope;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function assertClientName(client: string): void {
  if (!CLIENT_NAME_PATTERN.test(client)) throw new InvalidClientNameError(client);
}

export function isClientTokenScope(value: string): value is ClientTokenScope {
  return (CLIENT_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Mints a `scope` token for `client`, refusing a client that already holds a live one. */
export async function createClientToken(db: Database, client: string, scope: ClientTokenScope): Promise<CreatedClientToken> {
  assertClientName(client);
  const token = CLIENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  try {
    const [row] = await db
      .insert(clientTokens)
      .values({ client, scope, tokenHash: hashToken(token) })
      .returning({ createdAt: clientTokens.createdAt });
    if (!row) throw new Error("client_tokens insert returned no row");
    return { client, scope, token, createdAt: row.createdAt };
  } catch (err) {
    const pg = asPgError(err);
    if (pg?.code === "23505" && pg.constraint === "client_tokens_live_client_idx") {
      throw new ClientTokenExistsError(client);
    }
    throw err;
  }
}

/** Every token row, live and revoked, oldest first per client. Never selects the hash. */
export async function listClientTokens(db: Database): Promise<ClientTokenListing[]> {
  return db
    .select({
      client: clientTokens.client,
      scope: clientTokens.scope,
      createdAt: clientTokens.createdAt,
      lastUsedAt: clientTokens.lastUsedAt,
      revokedAt: clientTokens.revokedAt,
    })
    .from(clientTokens)
    .orderBy(asc(clientTokens.client), asc(clientTokens.createdAt));
}

/** Revokes `client`'s live token; throws `ClientTokenNotFoundError` if it has none. */
export async function revokeClientToken(db: Database, client: string): Promise<void> {
  assertClientName(client);
  const revoked = await db
    .update(clientTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(clientTokens.client, client), isNull(clientTokens.revokedAt)))
    .returning({ id: clientTokens.id });
  if (revoked.length === 0) throw new ClientTokenNotFoundError(client);
}

/**
 * The client and scope of a live token, or null for an unknown, revoked, or
 * malformed one. One statement: the lookup, plus a `last_used_at` touch when
 * the stored value is null or more than 60 s old.
 */
export async function verifyClientToken(db: Database, token: string): Promise<VerifiedClientToken | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const result = await db.execute<{ client: string; scope: ClientTokenScope }>(sql`
    WITH hit AS (
      SELECT id, client, scope, last_used_at FROM client_tokens
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    ),
    touch AS (
      UPDATE client_tokens c SET last_used_at = now()
      FROM hit
      WHERE c.id = hit.id
        AND (hit.last_used_at IS NULL OR hit.last_used_at < now() - interval '60 seconds')
      RETURNING c.id
    )
    SELECT client, scope FROM hit
  `);
  const row = result.rows[0];
  return row === undefined ? null : { client: row.client, scope: row.scope };
}
