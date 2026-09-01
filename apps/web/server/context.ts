// tRPC request context (bd-hmd.3). The database connection is opened once
// at startup (index.ts) and verified before the server ever listens — the
// context factory just closes over it, never opens or reads env itself,
// so this stays testable without a real HTTP request.

import type { Database } from "@breakdown/db";

export interface Context {
  db: Database;
}

/** Builds the per-request context factory tRPC's HTTP adapter calls. `db` is created once, at startup, and shared across every request. */
export function createContextFactory(db: Database) {
  return async (): Promise<Context> => ({ db });
}
