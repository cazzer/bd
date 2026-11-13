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
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { and, count, eq, inArray } from "drizzle-orm";
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

  it("createNote and annotateNode with an occurred_at that does not parse, or carries no zone, are rejected by core's normalizeOccurredAt before any ingest run opens — ctx.db is never touched (timeline-view)", async () => {
    await expect(callerWith(poisonedDb()).createNote({ metadata: { occurred_at: "last Tuesday" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining('occurred_at (got "last Tuesday")'),
    });
    await expect(callerWith(poisonedDb()).createNote({ metadata: { occurred_at: "2026-03-04T10:00:00" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("must carry a zone"),
    });
    await expect(
      callerWith(poisonedDb()).annotateNode({ targetNodeId: "00000000-0000-4000-8000-0000000000f3", metadata: { occurred_at: 1772611200000 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("occurred_at (got 1772611200000)") });
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

// tailnet-hosting decision 4: a write admitted by a client token records
// that client as its run's actor; a tokenless (loopback) one stays
// `human`. The source system is `human` either way. Fixtures are deleted
// by id: the node first, then its run.
describe("the actor a web write records", () => {
  it("is the context's client when one was admitted, and `human` without one", async () => {
    const withClient = await createCaller({ db, client: "phone" }).createNote({ content: "from the phone" });
    const without = await createCaller({ db, client: null }).createNote({ content: "from loopback" });
    const absent = await callerWith(db).createNote({ content: "from a direct caller" });
    const created = [withClient, without, absent];
    try {
      const runs = await db
        .select({ id: ingestRuns.id, actor: ingestRuns.actor, sourceSystem: ingestRuns.sourceSystem })
        .from(ingestRuns)
        .where(inArray(ingestRuns.id, created.map((c) => c.ingestRunId)));
      const byId = new Map(runs.map((r) => [r.id, r]));
      expect(byId.get(withClient.ingestRunId)).toMatchObject({ actor: "phone", sourceSystem: "human" });
      expect(byId.get(without.ingestRunId)).toMatchObject({ actor: "human", sourceSystem: "human" });
      expect(byId.get(absent.ingestRunId)).toMatchObject({ actor: "human", sourceSystem: "human" });
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, created.map((c) => c.id)));
      await db.delete(ingestRuns).where(inArray(ingestRuns.id, created.map((c) => c.ingestRunId)));
    }
  });
});

// BRAIN_READ_ONLY: every write procedure is refused before it touches the
// database, the same refusal the inbox procedures give.
describe("a read-only server refuses every write procedure", () => {
  const readOnly = () => createCaller({ db: poisonedDb(), readOnly: true });
  const node = "00000000-0000-4000-8000-0000000000f4";
  const edge = { srcId: node, dstId: "00000000-0000-4000-8000-0000000000f5", edgeType: "relates_to" };

  it.each([
    ["createNote", () => readOnly().createNote({ content: "x" })],
    ["annotateNode", () => readOnly().annotateNode({ targetNodeId: node, content: "x" })],
    ["updateNodeContent", () => readOnly().updateNodeContent({ nodeId: node, content: "x" })],
    ["assertEdge", () => readOnly().assertEdge(edge)],
    ["retractEdge", () => readOnly().retractEdge(edge)],
    ["reweightEdge", () => readOnly().reweightEdge({ ...edge, weight: 0.5 })],
  ] as const)("%s", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("read-only") });
  });
});
