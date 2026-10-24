// tRPC request context (bd-hmd.3). The database connection is opened once
// at startup (index.ts) and verified before the server ever listens — the
// context factory just closes over it, never opens or reads env itself,
// so this stays testable without a real HTTP request.

import type { Database } from "@breakdown/db";
import type { BeadsWatcher } from "./beads-watcher.js";

export interface Context {
  db: Database;
  /**
   * Character budget for a single procedure response's JSON payload — see
   * budget.ts. Unset in production (the HTTP context factory never sets
   * it, so every procedure bounds at `DEFAULT_RESPONSE_CHAR_BUDGET`); a
   * test injects a small one to prove trimming without writing megabytes
   * into the database. Same seam as apps/mcp's `ToolContext.responseCharBudget`.
   */
  responseCharBudget?: number;
  /** The beads watcher (index.ts creates it). Optional so callers that never touch the live board — every existing caller test — need not build one. */
  watcher?: BeadsWatcher;
  /** Aborted at shutdown; subscriptions end on it so shutdown never waits on a connected browser. */
  shutdownSignal?: AbortSignal;
}

/** Builds the per-request context factory tRPC's HTTP adapter calls. `db` is created once, at startup, and shared across every request. */
export function createContextFactory(db: Database, live: Pick<Context, "watcher" | "shutdownSignal"> = {}) {
  return async (): Promise<Context> => ({ db, ...live });
}
