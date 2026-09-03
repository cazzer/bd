// node-views, tasks.md 3.1: the two read procedures the feed view and the
// detail-panel affordance call — `list` (design.md decision 7, mirroring
// brain_list) and `resolveDefaultViews` — proven through the real router
// chain (Zod -> packages/core -> mapCoreError -> the response budget), the
// boundary the client actually depends on. packages/core/src/list.test.ts
// and views.test.ts cover the underlying functions in isolation and are
// trusted, not re-proven, here.
//
// Every fixture carries this file's own unique source system, every test
// tags its rows with a fresh `fx()` value and lists by that tag, and
// nothing here is ever asserted store-wide — this database is shared with
// every other test file in `pnpm test`, run concurrently (write.test.ts's
// header on why a global count flakes; `bd memories
// test-no-run-opened-assertions` on why ingest_runs is never asserted on).

import { randomUUID } from "node:crypto";
import { closeIngestRun, normalizeViewMetadata, openIngestRun, upsertEdges, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RESPONSE_CHAR_BUDGET } from "../budget.js";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;

const SRC = `nv-views-router-test-${randomUUID().replace(/-/g, "")}`;
const fx = () => `fx-${randomUUID().replace(/-/g, "")}`;
const FEED_FILTER = { nodeTypes: ["work_item"], where: [{ key: "status", op: "equals", value: "open" }] };

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, SRC, { actor: "views-router-suite" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
  await pool.end();
});

const createCaller = createCallerFactory(appRouter);

function caller() {
  const ctx: Context = { db };
  return createCaller(ctx);
}

/** Throws on any property access — proves Zod rejected the call before the resolver ran (write.test.ts's own device). */
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

async function writeNodes(specs: Array<{ externalId: string; nodeType: string; title?: string; metadata: Record<string, unknown> }>): Promise<Map<string, string>> {
  const result = await upsertNodes(
    db,
    run,
    specs.map((s) => ({ nodeType: s.nodeType, sourceSystem: SRC, externalId: s.externalId, title: s.title ?? s.externalId, content: "", metadata: s.metadata })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

async function link(srcId: string, dstId: string, edgeType: string): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType, sourceSystem: SRC }]);
}

describe("list (local-web-api spec, 'Listing a view's selection')", () => {
  it("applies a metadata predicate, returns metadata but never content, and a cursor continues without repeating or skipping a node", async () => {
    const batch = fx();
    const specs = [];
    for (let i = 0; i < 5; i++) specs.push({ externalId: `${batch}-open-${i}`, nodeType: "work_item", metadata: { batch, status: "open", priority: i } });
    for (let i = 0; i < 2; i++) specs.push({ externalId: `${batch}-closed-${i}`, nodeType: "work_item", metadata: { batch, status: "closed" } });
    const ids = await writeNodes(specs);
    const openIds = new Set([...ids.entries()].filter(([ext]) => ext.includes("-open-")).map(([, id]) => id));

    const input = { sourceSystems: [SRC], where: [{ key: "batch", op: "equals" as const, value: batch }, { key: "status", op: "equals" as const, value: "open" }], limit: 2 };

    const page1 = await caller().list(input);
    expect(page1.nodes).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.truncated).toBe(false);
    for (const row of page1.nodes) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("cursor");
      expect(row.metadata).toMatchObject({ batch, status: "open" });
      expect(typeof row.updatedAt).toBe("string");
      expect(row.isEditable).toBe(false); // SRC is neither "human" nor "agent"
    }

    const page2 = await caller().list({ ...input, cursor: page1.nextCursor! });
    expect(page2.nodes).toHaveLength(2);
    expect(page2.hasMore).toBe(true);

    const page3 = await caller().list({ ...input, cursor: page2.nextCursor! });
    expect(page3.nodes).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.nodes, ...page2.nodes, ...page3.nodes].map((n) => n.id);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(openIds);
  });

  it("trims a page that exceeds the response budget, and the cursor resumes at exactly the first dropped row", async () => {
    // 45 rows of ~48k characters each is ~2.16M — past DEFAULT_RESPONSE_CHAR_BUDGET
    // (2M) but well under the per-item shrink threshold (2x the budget), so
    // the budget DROPS tail rows rather than shrinking any: the case where a
    // cursor taken from core's page (the 45th row) would skip every dropped
    // row on the next call.
    const batch = fx();
    const count = 45;
    const pad = "x".repeat(47_900);
    const specs = [];
    for (let i = 0; i < count; i++) specs.push({ externalId: `${batch}-big-${String(i).padStart(2, "0")}`, nodeType: "blob", metadata: { batch, pad } });
    const ids = await writeNodes(specs);
    expect(ids.size).toBe(count);
    expect(JSON.stringify({ batch, pad }).length * count).toBeGreaterThan(DEFAULT_RESPONSE_CHAR_BUDGET);

    const input = { sourceSystems: [SRC], where: [{ key: "batch", op: "equals" as const, value: batch }], limit: count };

    const page1 = await caller().list(input);
    expect(page1.truncated).toBe(true);
    expect(page1.droppedNodeIds.length).toBeGreaterThan(0);
    expect(page1.shrunkNodeIds).toEqual([]);
    expect(page1.nodes.length + page1.droppedNodeIds.length).toBe(count);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor?.id).toBe(page1.nodes[page1.nodes.length - 1]?.id);
    expect(JSON.stringify(page1).length).toBeLessThanOrEqual(DEFAULT_RESPONSE_CHAR_BUDGET);

    const page2 = await caller().list({ ...input, cursor: page1.nextCursor! });
    expect(page2.nodes.map((n) => n.id)).toEqual(page1.droppedNodeIds);
    expect(page2.hasMore).toBe(false);
    expect(page2.truncated).toBe(false);

    const seen = [...page1.nodes, ...page2.nodes].map((n) => n.id);
    expect(new Set(seen).size).toBe(count);
    expect(new Set(seen)).toEqual(new Set(ids.values()));
  });

  it("rejects out-of-range options at the Zod boundary — ctx.db is never touched", async () => {
    await expect(callerWith(poisonedDb()).list({ limit: 501 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerWith(poisonedDb()).list({ nodeTypes: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerWith(poisonedDb()).list({ where: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, op: "equals" as const, value: 1 })) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(callerWith(poisonedDb()).list({ where: [{ key: "status", op: "contains", value: "op" }] } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps a well-formed cursor core does not recognise to BAD_REQUEST", async () => {
    await expect(caller().list({ cursor: { updatedAt: "yesterday", id: "not-a-uuid" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("resolveDefaultViews (local-web-api spec, 'Resolving default views for a page of nodes')", () => {
  it("answers a view for a child inheriting its epic's declaration, null for a node with none, in input order, in one call", async () => {
    const p = fx();
    const ids = await writeNodes([
      { externalId: `${p}-view`, nodeType: "view", title: "Open work", metadata: normalizeViewMetadata({ renderer: "feed", filter: FEED_FILTER }) },
      { externalId: `${p}-epic`, nodeType: "work_item", metadata: { status: "open" } },
      { externalId: `${p}-child`, nodeType: "work_item", metadata: { status: "open" } },
      { externalId: `${p}-orphan`, nodeType: "work_item", metadata: { status: "open" } },
    ]);
    const view = ids.get(`${p}-view`)!;
    const epic = ids.get(`${p}-epic`)!;
    const child = ids.get(`${p}-child`)!;
    const orphan = ids.get(`${p}-orphan`)!;
    await link(child, epic, "child_of");
    await link(epic, view, "default_view");

    const { results } = await caller().resolveDefaultViews({ ids: [orphan, child, epic] });
    expect(results).toEqual([
      { nodeId: orphan, view: null, declaredBy: null },
      { nodeId: child, view: { id: view, title: "Open work", renderer: "feed" }, declaredBy: epic },
      { nodeId: epic, view: { id: view, title: "Open work", renderer: "feed" }, declaredBy: epic },
    ]);
  });

  it("answers null for an id that names no node, rather than failing", async () => {
    const { results } = await caller().resolveDefaultViews({ ids: ["00000000-0000-4000-8000-000000000000"] });
    expect(results).toEqual([{ nodeId: "00000000-0000-4000-8000-000000000000", view: null, declaredBy: null }]);
  });

  it("rejects a malformed id, an empty batch, and more than 200 ids at the Zod boundary — ctx.db is never touched", async () => {
    await expect(callerWith(poisonedDb()).resolveDefaultViews({ ids: ["not-a-uuid"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerWith(poisonedDb()).resolveDefaultViews({ ids: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    await expect(callerWith(poisonedDb()).resolveDefaultViews({ ids: tooMany })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

function callerWith(dbInstance: Database) {
  const ctx: Context = { db: dbInstance };
  return createCaller(ctx);
}
