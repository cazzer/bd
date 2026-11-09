// Startup steps shared by every entrypoint of this server (design.md
// decision 1: the stdio and HTTP entrypoints differ only in transport):
// resolve DATABASE_URL, parse BRAIN_READ_ONLY, open the pool, and verify
// it before any tool call can arrive (brain-mcp spec, "Fail fast on
// misconfiguration"). A failure exits the process with an actionable
// message on stderr — never stdout, which is the stdio transport.
//
// Only startup is fail-fast. Once running, losing the database must not
// take the process down, and an EventEmitter with no 'error' listener
// throws, crashing the server. A dead connection surfaces on one of two
// paths, and attachPoolErrorLogger covers both:
// - Idle client: pg-pool re-emits the client's error as the pool's
//   'error' event. The pool listener logs it once to stderr.
// - Checked-out client (every drizzle transaction, so every write tool):
//   pg-pool removes its idle listener on checkout, so the error lands on
//   the client itself. Each client gets a no-op listener at 'connect'.
//   pg already fails the in-flight query and rejects later ones, so the
//   tool returns its normal error; logging here too would print an idle
//   failure twice.
// Tool calls fail with their usual errors until the database returns.
//
// Nothing here runs at import: module scope only defines bootstrap(), so
// an entrypoint decides when the environment is read and the connection
// opened.

import { createDb, createPool, DatabaseUrlNotSetError, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { parseReadOnly } from "./config.js";
import { describeConnectionError, describeConnectionTarget, verifyDatabaseConnection, type Pool } from "./startup.js";

export interface Bootstrapped {
  db: Database;
  pool: Pool;
  readOnly: boolean;
  /** `host:port/database`, credentials stripped — safe for a log line. */
  target: string;
}

/** Keeps a lost connection, idle or checked out, from crashing the process; see the module header for the two paths. */
export function attachPoolErrorLogger(pool: Pool): void {
  pool.on("error", (err) => {
    console.error(`[breakdown-brain] database connection lost: ${describeConnectionError(err)} (server keeps running; calls fail until it returns)`);
  });
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
}

/** Runs the shared startup steps, or exits the process (code 1) with the reason on stderr. */
export async function bootstrap(): Promise<Bootstrapped> {
  let databaseUrl: string;
  try {
    // The only credential this server requires — see resolveDatabaseUrl,
    // which also loads the workspace-root .env and already produces an
    // actionable message (naming the .env path it looked for) when unset.
    databaseUrl = resolveDatabaseUrl();
  } catch (err) {
    const message = err instanceof DatabaseUrlNotSetError ? err.message : String(err);
    console.error(`[breakdown-brain] cannot start: ${message}`);
    process.exit(1);
  }

  const readOnly = parseReadOnly(process.env["BRAIN_READ_ONLY"]);
  const target = describeConnectionTarget(databaseUrl);
  const pool = createPool(databaseUrl);
  attachPoolErrorLogger(pool);

  try {
    await verifyDatabaseConnection(pool);
  } catch (err) {
    const detail = describeConnectionError(err);
    console.error(
      `[breakdown-brain] cannot start: database at ${target} is unreachable (${detail}). ` +
        "Check that it is running and that DATABASE_URL is correct (see .env.example), then retry.",
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }

  return { db: createDb(pool), pool, readOnly, target };
}
