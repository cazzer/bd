import { eq, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { EdgeUpsertFailedError } from "./errors.js";
import { InvalidEventTimeError, InvalidLookupIdError, InvalidLookupOptionError, InvalidWorkItemError, NodeNotFoundError, NotAWorkItemError } from "./errors.js";
import { getNodeHistory } from "./history.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";
import {
  BLOCKS_EDGE_TYPE,
  buildWorkItemReadinessQuery,
  getWorkItemReadiness,
  normalizeWorkItemMetadata,
  patchWorkItem,
  readWorkItemFields,
  WORK_ITEM_NODE_TYPE,
} from "./work-items.js";

const SRC = `work-items-test-${uniqueSuffix()}`;
// Readiness fixtures are scoped by spec_id so the report is filtered to
// this suite's items even though blockers are considered store-wide.
const SPEC = `spec-${uniqueSuffix()}`;
// The readiness fixtures get their own spec_id so the patch fixtures above
// (which are also open work items) never show up in the report.
const READY_SPEC = `ready-${uniqueSuffix()}`;

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
const openRuns: string[] = [];

async function newRun(actor?: string): Promise<IngestRunHandle> {
  const r = await openIngestRun(db, SRC, actor === undefined ? {} : { actor });
  openRuns.push(r.id);
  return r;
}

async function writeItem(externalId: string, metadata: Record<string, unknown>, nodeType = WORK_ITEM_NODE_TYPE, writer: IngestRunHandle = run): Promise<string> {
  const result = await upsertNodes(db, writer, [
    { nodeType, sourceSystem: SRC, externalId, title: `item ${externalId}`, content: `content ${externalId}`, metadata: { spec_id: SPEC, ...metadata } },
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row.id;
}

function writeReady(externalId: string, metadata: Record<string, unknown>, nodeType = WORK_ITEM_NODE_TYPE): Promise<string> {
  return writeItem(externalId, { ...metadata, spec_id: READY_SPEC }, nodeType);
}

async function blocks(srcId: string, dstId: string): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType: BLOCKS_EDGE_TYPE, sourceSystem: SRC }]);
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await newRun("work-items-suite");
});

afterAll(async () => {
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRuns));
  await pool.end();
});

describe("normalizeWorkItemMetadata", () => {
  it("defaults a missing status and priority and passes other keys through", () => {
    expect(normalizeWorkItemMetadata({ labels: ["a"] })).toEqual({ status: "open", priority: 2, labels: ["a"] });
    expect(normalizeWorkItemMetadata(undefined)).toEqual({ status: "open", priority: 2 });
  });

  it("rejects a status outside the contract, naming the field and value", () => {
    let thrown: unknown;
    try {
      normalizeWorkItemMetadata({ status: "done" }, { index: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidWorkItemError);
    const e = thrown as InvalidWorkItemError;
    expect(e.field).toBe("status");
    expect(e.value).toBe("done");
    expect(e.index).toBe(3);
    expect(e.message).toContain("batch index 3");
  });

  it("rejects priorities outside 0..4 and non-integers", () => {
    for (const priority of [-1, 5, 1.5, "1"]) {
      expect(() => normalizeWorkItemMetadata({ priority })).toThrow(InvalidWorkItemError);
    }
  });

  it("stamps closed_at when an item closes without one, and normalizes a supplied one", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    expect(normalizeWorkItemMetadata({ status: "closed", closed_reason: "done" }, { now })).toEqual({
      status: "closed",
      priority: 2,
      closed_at: "2026-09-02T12:00:00.000Z",
      closed_reason: "done",
    });
    expect(normalizeWorkItemMetadata({ status: "closed", closed_at: "2026-01-01T00:00:00Z" }, { now })["closed_at"]).toBe("2026-01-01T00:00:00.000Z");
    expect(() => normalizeWorkItemMetadata({ status: "closed", closed_at: "yesterday" })).toThrow(InvalidWorkItemError);
  });

  it("clears closing fields on any non-closed status", () => {
    expect(normalizeWorkItemMetadata({ status: "open", closed_at: "2026-01-01T00:00:00Z", closed_reason: "stale" })).toEqual({ status: "open", priority: 2 });
  });

  it("trims optional strings, drops blanks, and bounds their length", () => {
    expect(normalizeWorkItemMetadata({ assignee: "  caleb ", spec_id: "", closed_reason: null })).toEqual({ status: "open", priority: 2, assignee: "caleb" });
    expect(() => normalizeWorkItemMetadata({ assignee: "x".repeat(201) })).toThrow(InvalidWorkItemError);
    expect(() => normalizeWorkItemMetadata({ assignee: 42 })).toThrow(InvalidWorkItemError);
  });

  it("readWorkItemFields is lenient about pre-contract metadata", () => {
    expect(readWorkItemFields({ status: "weird", priority: 9, assignee: 1 })).toEqual({
      status: "open",
      priority: 2,
      assignee: null,
      closedAt: null,
      closedReason: null,
      specId: null,
    });
  });
});

describe("patchWorkItem", () => {
  it("patches status only, leaves the content hash alone, and records one attributed revision", async () => {
    const id = await writeItem("patch-1", { status: "open", priority: 1 });
    const patcher = await newRun("patcher");
    const before = await getNodeHistory(db, id);

    const result = await patchWorkItem(db, patcher, id, { status: "in_progress" });
    expect(result.id).toBe(id);
    expect(result.action).toBe("updated");
    expect(result.before.status).toBe("open");
    expect(result.after).toEqual({ status: "in_progress", priority: 1, assignee: null, closedAt: null, closedReason: null, specId: SPEC });

    const after = await getNodeHistory(db, id);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    const newest = after.revisions[0];
    expect(newest?.changedFields).toEqual(["metadata"]);
    expect(newest?.metadataChanges).toEqual({ status: { before: "open", after: "in_progress" } });
    expect(newest?.contentHash).toBe(before.revisions[0]?.contentHash);
    expect(newest?.ingestRun.id).toBe(patcher.id);
    expect(newest?.ingestRun.actor).toBe("patcher");
  });

  it("closing stamps closed_at and reopening clears it; a no-op patch reports unchanged", async () => {
    const id = await writeItem("patch-2", { status: "open" });
    const closed = await patchWorkItem(db, run, id, { status: "closed", closedReason: "shipped" });
    expect(closed.after.status).toBe("closed");
    expect(closed.after.closedReason).toBe("shipped");
    expect(closed.after.closedAt).not.toBeNull();

    const same = await patchWorkItem(db, run, id, { closedReason: "shipped" });
    expect(same.action).toBe("unchanged");

    const reopened = await patchWorkItem(db, run, id, { status: "open" });
    expect(reopened.after.closedAt).toBeNull();
    expect(reopened.after.closedReason).toBeNull();
  });

  it("null in the patch removes a key", async () => {
    const id = await writeItem("patch-3", { assignee: "caleb" });
    const result = await patchWorkItem(db, run, id, { assignee: null });
    expect(result.before.assignee).toBe("caleb");
    expect(result.after.assignee).toBeNull();
  });

  it("rejects a node that is not a work item, naming its type", async () => {
    const id = await writeItem("patch-note", {}, "note");
    await expect(patchWorkItem(db, run, id, { status: "closed" })).rejects.toMatchObject({ nodeId: id, nodeType: "note" });
    await expect(patchWorkItem(db, run, id, { status: "closed" })).rejects.toBeInstanceOf(NotAWorkItemError);
  });

  it("rejects a patch whose result violates the contract, persisting nothing", async () => {
    const id = await writeItem("patch-4", { status: "open", priority: 1 });
    await expect(patchWorkItem(db, run, id, { priority: 7 })).rejects.toBeInstanceOf(InvalidWorkItemError);
    const [row] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, id));
    expect((row?.metadata as Record<string, unknown>)["priority"]).toBe(1);
  });

  it("canonicalizes an occurred_at the row carries and rejects one that does not parse, naming occurred_at and persisting nothing", async () => {
    // The patch cannot set occurred_at; the merged document inherits the
    // row's, which the raw upsert here wrote past the contract on purpose.
    const good = await writeItem("patch-time-good", { status: "open", occurred_at: "2026-03-04T10:00:00+02:00" });
    const result = await patchWorkItem(db, run, good, { priority: 0 });
    expect(result.action).toBe("updated");
    const [goodRow] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, good));
    expect(goodRow?.metadata).toMatchObject({ priority: 0, occurred_at: "2026-03-04T08:00:00.000Z" });

    const bad = await writeItem("patch-time-bad", { status: "open", occurred_at: "last Tuesday" });
    await expect(patchWorkItem(db, run, bad, { priority: 0 })).rejects.toBeInstanceOf(InvalidEventTimeError);
    await expect(patchWorkItem(db, run, bad, { priority: 0 })).rejects.toThrow(/occurred_at \(got "last Tuesday"\)/);
    const [badRow] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, bad));
    expect(badRow?.metadata).toEqual({ spec_id: SPEC, status: "open", occurred_at: "last Tuesday" });
  });

  it("applies a patch aimed at a merged-away node to its survivor", async () => {
    const loser = await writeItem("patch-loser", { status: "open" });
    const survivor = await writeItem("patch-survivor", { status: "open", priority: 3 });
    await mergeNodes(db, loser, survivor, run);
    const result = await patchWorkItem(db, run, loser, { priority: 0 });
    expect(result.requestedId).toBe(loser);
    expect(result.id).toBe(survivor);
    expect(result.after.priority).toBe(0);
  });

  it("rejects a malformed id and an unknown id", async () => {
    await expect(patchWorkItem(db, run, "nope", {})).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(patchWorkItem(db, run, "00000000-0000-4000-8000-000000000000", {})).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("serializes concurrent patches so both land", async () => {
    const id = await writeItem("patch-concurrent", { status: "open" });
    const [a, b] = await Promise.all([
      patchWorkItem(db, await newRun("a"), id, { assignee: "a" }),
      patchWorkItem(db, await newRun("b"), id, { priority: 0 }),
    ]);
    expect([a.action, b.action]).toEqual(["updated", "updated"]);
    const [row] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, id));
    expect(row?.metadata).toMatchObject({ assignee: "a", priority: 0, status: "open" });
    const history = await getNodeHistory(db, id);
    expect(history.revisions).toHaveLength(3);
  });
});

describe("getWorkItemReadiness", () => {
  it("reports ready, blocked, non-work-item blockers, merged aliases, deferred/closed, and merge-created cycles", async () => {
    // A (closed) blocks B  -> B ready
    const a = await writeReady("r-a", { status: "closed" });
    const b = await writeReady("r-b", { status: "open", priority: 0 });
    await blocks(a, b);
    // C (in progress) blocks D -> D blocked by C
    const c = await writeReady("r-c", { status: "in_progress" });
    const d = await writeReady("r-d", { status: "open" });
    await blocks(c, d);
    // note E blocks F -> F blocked (a non-work-item has no status to be closed)
    const e = await writeReady("r-e", {}, "note");
    const f = await writeReady("r-f", { status: "open" });
    await blocks(e, f);
    // G blocks X; X merged into H -> H blocked by G
    const g = await writeReady("r-g", { status: "open" });
    const x = await writeReady("r-x", { status: "open" });
    const h = await writeReady("r-h", { status: "open" });
    await blocks(g, x);
    await mergeNodes(db, x, h, run);
    // deferred and closed with no blockers: neither list
    await writeReady("r-deferred", { status: "deferred" });
    await writeReady("r-closed", { status: "closed" });
    // P blocks Q, Q blocks R, R merged into P -> P and Q form a cycle
    const p = await writeReady("r-p", { status: "open" });
    const q = await writeReady("r-q", { status: "open" });
    const r = await writeReady("r-r", { status: "open" });
    await blocks(p, q);
    await blocks(q, r);
    await mergeNodes(db, r, p, run);
    // an unblocked open item with lower priority than B
    const solo = await writeReady("r-solo", { status: "open", priority: 3 });

    const report = await getWorkItemReadiness(db, { specId: READY_SPEC });

    expect(report.ready.map((i) => i.externalId)).toEqual(["r-b", "r-g", "r-solo"]);
    expect(report.ready[0]).toMatchObject({ id: b, status: "open", priority: 0, specId: READY_SPEC, sourceSystem: SRC });
    expect(report.readyHasMore).toBe(false);

    const blockedById = new Map(report.blocked.map((i) => [i.id, i]));
    expect(blockedById.get(d)?.openBlockerIds).toEqual([c]);
    expect(blockedById.get(f)?.openBlockerIds).toEqual([e]);
    expect(blockedById.get(h)?.openBlockerIds).toEqual([g]);
    expect(blockedById.get(q)?.openBlockerIds).toEqual([p]);
    expect(blockedById.get(q)?.inCycle).toBe(true);
    expect(blockedById.get(p)?.openBlockerIds).toEqual([q]);
    expect(blockedById.get(p)?.inCycle).toBe(true);
    expect(blockedById.get(d)?.inCycle).toBe(false);
    expect(blockedById.has(solo)).toBe(false);

    expect([...report.cycleMemberIds].sort()).toEqual([p, q].sort());
    const allIds = [...report.ready, ...report.blocked].map((i) => i.externalId);
    expect(allIds).not.toContain("r-deferred");
    expect(allIds).not.toContain("r-closed");
    expect(allIds).not.toContain("r-x");
  });

  it("bounds the lists and reports whether more exist", async () => {
    const report = await getWorkItemReadiness(db, { specId: READY_SPEC, readyLimit: 1, blockedLimit: 2 });
    expect(report.ready).toHaveLength(1);
    expect(report.ready[0]?.externalId).toBe("r-b");
    expect(report.readyHasMore).toBe(true);
    expect(report.blocked).toHaveLength(2);
    expect(report.blockedHasMore).toBe(true);
  });

  it("rejects bad options before any SQL runs", async () => {
    let executed = 0;
    const spy = { execute: async () => { executed += 1; return { rows: [] }; } } as unknown as Database;
    await expect(getWorkItemReadiness(spy, { readyLimit: 0 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getWorkItemReadiness(spy, { blockedLimit: 501 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getWorkItemReadiness(spy, { specId: "" })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    expect(executed).toBe(0);
  });

  it("buildWorkItemReadinessQuery is pure", () => {
    const dialect = new PgDialect();
    const params = { specId: "x", readyLimit: 5, blockedLimit: 5 };
    const a = dialect.sqlToQuery(buildWorkItemReadinessQuery(params));
    const b = dialect.sqlToQuery(buildWorkItemReadinessQuery(params));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });
});


describe("dense layered blocks DAG (polynomial cycle checks)", () => {
  // 8 layers x 8 nodes, every node blocking every node of the next layer:
  // 448 edges and about 8^7 (two million) distinct paths. A simple-path
  // enumeration would take minutes here and days at 10 x 10; the
  // set-semantics walks in the trigger and the readiness query must stay
  // in seconds.
  const LAYERS = 8;
  const WIDTH = 8;
  const DAG_SPEC = `dag-${uniqueSuffix()}`;

  it("inserts, reports readiness, and still refuses a cycle-closing edge, each within seconds", async () => {
    const inputs = [];
    for (let layer = 0; layer < LAYERS; layer += 1) {
      for (let i = 0; i < WIDTH; i += 1) {
        inputs.push({ nodeType: WORK_ITEM_NODE_TYPE, sourceSystem: SRC, externalId: `dag-${layer}-${i}`, title: `dag ${layer} ${i}`, content: "", metadata: { status: "open", priority: 2, spec_id: DAG_SPEC } });
      }
    }
    const written = await upsertNodes(db, run, inputs);
    const idOf = new Map(written.rows.map((r) => [r.externalId, r.id]));
    const layerIds = (layer: number) => Array.from({ length: WIDTH }, (_, i) => idOf.get(`dag-${layer}-${i}`)!);

    const edgeInputs = [];
    for (let layer = 0; layer < LAYERS - 1; layer += 1) {
      for (const srcId of layerIds(layer)) {
        for (const dstId of layerIds(layer + 1)) {
          edgeInputs.push({ srcId, dstId, edgeType: BLOCKS_EDGE_TYPE, sourceSystem: SRC });
        }
      }
    }
    expect(edgeInputs).toHaveLength((LAYERS - 1) * WIDTH * WIDTH);

    const t0 = performance.now();
    const edgeResult = await upsertEdges(db, run, edgeInputs);
    const insertMs = performance.now() - t0;
    expect(edgeResult.created).toBe(edgeInputs.length);

    const t1 = performance.now();
    const report = await getWorkItemReadiness(db, { specId: DAG_SPEC, readyLimit: 500, blockedLimit: 500 });
    const readyMs = performance.now() - t1;
    expect(report.ready.map((i) => i.externalId).sort()).toEqual(layerIds(0).map((_, i) => `dag-0-${i}`).sort());
    expect(report.blocked).toHaveLength((LAYERS - 1) * WIDTH);
    expect(report.blocked.every((b) => b.openBlockerIds.length === WIDTH && !b.inCycle)).toBe(true);
    expect(report.cycleMemberIds).toEqual([]);

    const t2 = performance.now();
    await expect(upsertEdges(db, run, [{ srcId: layerIds(LAYERS - 1)[0]!, dstId: layerIds(0)[0]!, edgeType: BLOCKS_EDGE_TYPE, sourceSystem: SRC }])).rejects.toBeInstanceOf(EdgeUpsertFailedError);
    const refuseMs = performance.now() - t2;

    console.log(`[dag ${LAYERS}x${WIDTH}] insert ${Math.round(insertMs)} ms, readiness ${Math.round(readyMs)} ms, refused cycle edge ${Math.round(refuseMs)} ms`);
    expect(insertMs).toBeLessThan(10_000);
    expect(readyMs).toBeLessThan(10_000);
    expect(refuseMs).toBeLessThan(10_000);
  });
});
