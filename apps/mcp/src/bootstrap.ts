// Startup steps shared by every entrypoint of this server (design.md
// decision 1: the stdio and HTTP entrypoints differ only in transport):
// resolve DATABASE_URL, parse BRAIN_READ_ONLY, open the pool, and verify
// it before any tool call can arrive (brain-mcp spec, "Fail fast on
// misconfiguration"). A failure exits the process with an actionable
// message on stderr — never stdout, which is the stdio transport.
//
// Only startup is fail-fast. Once running, losing the database must not
// take the process down: pg-pool emits 'error' when an idle client's
// connection dies (Postgres stopped or restarted), and an EventEmitter
// with no 'error' listener throws, crashing the server. The pool gets a
// listener that logs and keeps running, so tool calls fail with their
// usual errors until the database returns.
//
// Nothing here runs at import: module scope only defines bootstrap(), so
// an entrypoint decides when the environment is read and the connection
// opened.

import { createDb, createPool, DatabaseUrlNotSetError, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { parseReadOnly } from "./config.js";
import { describeConnectionError, describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

type Pool = ReturnType<typeof createPool>;

export interface Bootstrapped {
  db: Database;
  pool: Pool;
  readOnly: boolean;
  /** `host:port/database`, credentials stripped — safe for a log line. */
  target: string;
}

/** Logs a lost idle connection to stderr instead of letting pg-pool's unhandled 'error' event crash the process. */
export function attachPoolErrorLogger(pool: Pool): void {
  pool.on("error", (err) => {
    console.error(`[breakdown-brain] database connection lost: ${describeConnectionError(err)} (server keeps running; calls fail until it returns)`);
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
