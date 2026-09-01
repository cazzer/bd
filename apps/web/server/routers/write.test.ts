// bd-hmd.3 review, priority 4: a rejected write persists nothing — proven
// against the real router chain (Zod -> packages/core -> mapCoreError),
// not just core in isolation (packages/core/src/nodes.test.ts already
// covers the equivalent core-level case with a title/content cap
// directly).
//
// This file's tests deliberately avoid "count all rows before/after" —
// this test database is shared with every other test file in this
// workspace's `pnpm test`, run concurrently across files (proven the
// hard way: an earlier version of this file counted `edges` globally and
// intermittently saw ~500 extra rows that were another file's own
// in-flight fixtures, nothing to do with this file's own calls). Instead:
//
//   - The title-cap and content-cap rejections are both pure validation
//     (Zod's own schema for title; packages/core's unsafePrepareNodes,
//     called before any ingest run opens, for content) — neither one
//     ever touches the database at all. `poisonedDb()` proves that
//     directly: any property access on it throws, so if validation ever
//     let a call reach `ctx.db`, the test would fail with the wrong
//     error code instead of silently passing.
//   - The edge rejection uses `reweightEdge` on an edge no human ever
//     asserted, not `assertEdge` against a nonexistent node id: core's
//     `reweightEdge` checks existence with a plain SELECT *before*
//     opening an ingest run, so a real database round trip that finds
//     nothing genuinely writes nothing — no ingest_runs row either,
//     unlike `assertEdge`'s foreign-key-violation path (which opens a
//     run before the insert fails at the database, and would otherwise
//     need cleanup this file can't do race-free against concurrent
//     writers). The check afterward is scoped to the exact
//     (srcId, dstId, edgeType) triple this test used — not a global
//     count — so it can't be polluted by another file's fixtures either.

import { createDb, createPool, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { edges } from "@breakdown/db";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
});

/** Throws on any property access — proves a code path never actually touches the database, not merely that it received a reference to it. */
function poisonedDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("ctx.db should never be touched for a request rejected by validation before any database call");
      },
    },
  ) as Database;
}

const createCaller = createCallerFactory(appRouter);

function callerWith(dbInstance: Database) {
  const ctx: Context = { db: dbInstance };
  return createCaller(ctx);
}

describe("a rejected write persists nothing (bd-hmd.3 review)", () => {
  it("createNote with an over-cap title is rejected by Zod before reaching the resolver — ctx.db is never touched", async () => {
    await expect(callerWith(poisonedDb()).createNote({ title: "x".repeat(600) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("createNote with content over core's cap is rejected by unsafePrepareNodes before any ingest run opens — ctx.db is never touched (Zod lets content through; this is core's own boundary)", async () => {
    await expect(callerWith(poisonedDb()).createNote({ content: "x".repeat(1_000_001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reweightEdge on an edge no human ever asserted is rejected, and no such edge exists before or after", async () => {
    const srcId = "00000000-0000-0000-0000-0000000000f1";
    const dstId = "00000000-0000-0000-0000-0000000000f2";
    const edgeType = "bd-hmd-3-review-nonexistent-edge-probe";
    const scoped = and(eq(edges.srcId, srcId), eq(edges.dstId, dstId), eq(edges.edgeType, edgeType));

    const [before] = await db.select({ n: count() }).from(edges).where(scoped);
    expect(before?.n ?? 0).toBe(0);

    await expect(callerWith(db).reweightEdge({ srcId, dstId, edgeType, weight: 0.5 })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [after] = await db.select({ n: count() }).from(edges).where(scoped);
    expect(after?.n ?? 0).toBe(0);
  });
});
