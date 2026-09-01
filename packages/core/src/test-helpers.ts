import { randomUUID } from "node:crypto";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";

/** The pool type `createPool` returns — avoids test files needing their own `pg` dependency just for this. */
export type TestPool = ReturnType<typeof createPool>;

/**
 * Shared connection setup for the integration test suites in this
 * package. Every test suite still opens/tears down its own pool in
 * `beforeAll`/`afterAll` (so suites can run in isolation) — this just
 * avoids repeating the two-line dance across four files.
 */
export function connectTestDb() {
  const pool = createPool(resolveDatabaseUrl());
  const db = createDb(pool);
  return { pool, db };
}

/** A short, collision-resistant suffix for building unique test fixture keys. */
export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, "");
}
