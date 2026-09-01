import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

/**
 * Explicit construction only — nothing here runs at module scope. Callers
 * (migrate.ts, apps/mcp startup, tests) decide when to open a connection
 * and with what connection string, and are responsible for calling
 * pool.end() when done.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
