// Fail-fast startup checks (brain-mcp spec, "Fail fast on misconfiguration"):
// the server validates its database connection before ever accepting a
// tool call, and index.ts exits with a message naming the connection
// target when it can't — rather than accepting the connection and failing
// opaquely on the first tool call.

import type { createPool } from "@breakdown/db";

// Avoids a direct `pg` dependency for just this one type — same trick
// packages/core/src/test-helpers.ts uses for TestPool.
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
