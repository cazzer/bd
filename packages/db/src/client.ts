import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

/**
 * Explicit construction only — nothing here runs at module scope. Callers
 * (migrate.ts, apps/mcp startup, tests) decide when to open a connection
 * and with what connection string, and are responsible for calling
 * pool.end() when done.
 */
/**
 * Backstop for any statement that runs away — a recursive query over a
 * pathological graph, a lock wait that never resolves. Applied per
 * connection by node-postgres. A deliberate constant, not an environment
 * variable (CLAUDE.md fixes that list): 60 s is two orders of magnitude
 * above the largest measured batch (5,000 nodes in well under a second)
 * and the history backfill, and far below "the server hung".
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
