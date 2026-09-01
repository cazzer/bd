// Fail-fast startup checks (bd-hmd.3, mirroring apps/mcp/src/startup.ts's
// approach exactly): the server verifies its database connection before
// ever binding its listener, and index.ts exits with a message naming the
// connection target when it can't — rather than binding the port and
// failing opaquely on the first request.
//
// Duplicated from apps/mcp/src/startup.ts rather than imported: apps/mcp
// exposes no package entry point for another app to depend on (no
// `exports` map, and its `main` is its own stdio entrypoint), and
// design.md's "Two adapters over one core" is explicit that the two
// adapters don't share code — only `packages/core` does. Both bugs this
// solves are real and already found once; re-solving them here would be
// the mistake, so the logic below is copied, not reinvented.

import type { createPool } from "@breakdown/db";

// Avoids a direct `pg` dependency for just this one type — same trick
// apps/mcp/src/startup.ts and packages/core/src/test-helpers.ts use.
type Pool = ReturnType<typeof createPool>;

/** `host:port/database`, with credentials and query-string params stripped — safe to put in a startup error message. */
export function describeConnectionTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}:${url.port || "5432"}/${database}`;
  } catch {
    return "(DATABASE_URL could not be parsed as a URL)";
  }
}

/**
 * Throws if the database is unreachable or rejects a trivial query.
 * Never exits the process itself — index.ts owns that decision, so this
 * stays testable as a plain function.
 */
export async function verifyDatabaseConnection(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Renders the actual failure detail from whatever `verifyDatabaseConnection`
 * (or a bare pool connection) threw, for an actionable startup message.
 *
 * `err.message` is not enough on its own: a dual-stack host — exactly
 * what `localhost` is, and what `.env.example`/every real setup here
 * uses — makes Node's `net`/`pg` connection attempt both the IPv6 and
 * IPv4 addresses in parallel and, when both fail, reject with a plain
 * `AggregateError` whose own `.message` is `""`. The real detail
 * ("connect ECONNREFUSED ::1:1", "connect ECONNREFUSED 127.0.0.1:1") is
 * one message per attempt in `.errors`, not on the aggregate itself.
 */
export function describeConnectionError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map((e) => (e instanceof Error ? e.message : String(e))).filter((m) => m.length > 0);
    if (inner.length > 0) return inner.join("; ");
    return err.message || `${err.constructor.name} (no further detail)`;
  }
  if (err instanceof Error) {
    return err.message || err.constructor.name;
  }
  return String(err);
}
