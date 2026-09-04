// bd-hmd.6, task 6.6: server-level tests for the graph-explorer/spec.md
// scenarios this ticket implements —
//   - "Opening a repo-sourced node": no editing affordance
//   - "Annotating a read-only node": the annotated node's own content is
//     unchanged
//   - "Editing an editable node": the new content is searchable
//   - "Creating a standalone note": findable by search despite no edges
//   - "Connecting two nodes by hand" / "Reweighting an edge": a full
//     assert -> confirm-via-getNeighbors -> reweight -> retract round
//     trip through the router (review follow-up: write.test.ts only
//     covers assertEdge/retractEdge/reweightEdge's REJECTION paths — a
//     bad weight, a nonexistent edge — so nothing anywhere drove a
//     successful sequence through Zod validation and mapCoreError for
//     these three procedures before this).
//
// packages/core/src/human-writes.test.ts already covers the underlying
// write functions in isolation (annotate leaves content unchanged,
// updateNodeContent refuses a repo-sourced node, assert/retract/reweight
// edge semantics, etc. — trusted, not re-proven here per this ticket's
// "trust internal code" boundary). These tests instead prove the same
// behaviour holds through the actual tRPC router the UI calls — Zod
// validation, mapCoreError, and server/dto.ts's `isEditable` flag —
// which is the boundary the client actually depends on and that this
// ticket's own code (dto.ts, routers/read.ts's new `listUnlinkedNotes`)
// adds.
//
// Fixtures and cleanup follow packages/core/src/human-writes.test.ts's
// established convention exactly: every fixture/write is tracked by id
// and deleted in `afterEach` — never a sweep scoped to a shared
// source_system like "human"/"repo" — because the seeded corpus's own
// 9 nodes/16 edges live under `source_system='repo'` and must never be
// touched. A repo-sourced FIXTURE node stands in for a real corpus node;
// its own ingest run opens under a unique test-scoped source_system
// (never the literal "repo"), matching human-writes.test.ts's own
// `newFixtureRun`/`makeFixtureNode` reasoning — the node's `sourceSystem`
// field (what `isEditableSourceSystem` actually reads) is still the
// literal "repo".

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, upsertNodes } from "@breakdown/core";
import { createDb, createPool, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;

const createdNodeIds: string[] = [];
const createdRunIds: string[] = [];

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterEach(async () => {
  if (createdNodeIds.length > 0) {
    // Cascades to any edge touching one of these nodes (edges.src_id/
    // dst_id are ON DELETE CASCADE, per human-writes.test.ts) — covers an
    // annotation's own `annotates` edge without a separate delete.
    await db.delete(nodes).where(inArray(nodes.id, createdNodeIds));
    createdNodeIds.length = 0;
  }
  if (createdRunIds.length > 0) {
    await db.delete(ingestRuns).where(inArray(ingestRuns.id, createdRunIds));
    createdRunIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

const createCaller = createCallerFactory(appRouter);
function caller() {
  const ctx: Context = { db };
  return createCaller(ctx);
}

/** A throwaway repo-sourced fixture node — never a real corpus row. See module header on why its ingest run opens under a unique test-scoped source_system rather than the literal "repo". */
async function makeRepoFixtureNode(content = "fixture repo content"): Promise<string> {
  const run = await openIngestRun(db, `bd-hmd6-test-repo-${randomUUID()}`);
  createdRunIds.push(run.id);
  const externalId = `test-fixtures/bd-hmd6-${randomUUID()}.md`;
  const result = await upsertNodes(db, run, [{ nodeType: "doc", sourceSystem: "repo", externalId, title: "bd-hmd.6 fixture", content }]);
  await closeIngestRun(db, run);
  const row = result.rows[0];
  if (!row) throw new Error("fixture setup failed");
  createdNodeIds.push(row.id);
  return row.id;
}

describe("a person's occurred_at is stored canonical (timeline-view, knowledge-store spec 'A time in another zone is canonicalized')", () => {
  it("createNote and updateNodeContent both canonicalize a zoned time; updateNodeContent without metadata keeps it", async () => {
    const created = await caller().createNote({ title: "timed note", metadata: { occurred_at: "2026-03-04T10:00:00+02:00", note: "kept" } });
    createdNodeIds.push(created.id);
    createdRunIds.push(created.ingestRunId);
    const [afterCreate] = await db.select({ metadata: nodes.metadata }).from(nodes).where(inArray(nodes.id, [created.id]));
    expect(afterCreate?.metadata).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z", note: "kept" });

    const updated = await caller().updateNodeContent({ nodeId: created.id, metadata: { occurred_at: "2026-03-05" } });
    createdRunIds.push(updated.ingestRunId);
    const [afterUpdate] = await db.select({ metadata: nodes.metadata }).from(nodes).where(inArray(nodes.id, [created.id]));
    expect(afterUpdate?.metadata).toEqual({ occurred_at: "2026-03-05T00:00:00.000Z" });

    const contentOnly = await caller().updateNodeContent({ nodeId: created.id, content: "edited" });
    createdRunIds.push(contentOnly.ingestRunId);
    const [afterContent] = await db.select({ metadata: nodes.metadata }).from(nodes).where(inArray(nodes.id, [created.id]));
    expect(afterContent?.metadata).toEqual({ occurred_at: "2026-03-05T00:00:00.000Z" });
  });
});

describe("a repo-sourced node offers no editing affordance (graph-explorer/spec.md, 'Opening a repo-sourced node')", () => {
  it("getNodes reports isEditable: false — the flag DetailPanel.tsx gates the edit form on", async () => {
    const id = await makeRepoFixtureNode();
    const result = await caller().getNodes({ ids: [id] });
    expect(result.nodes[0]?.isEditable).toBe(false);
  });

  it("updateNodeContent refuses to edit it, naming the node as not editable", async () => {
    const id = await makeRepoFixtureNode();
    await expect(caller().updateNodeContent({ nodeId: id, content: "a hand edit that must not land" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("annotating a read-only node leaves its content unchanged (graph-explorer/spec.md, 'Annotating a read-only node')", () => {
  it("content, title, and updatedAt survive an annotation unchanged", async () => {
    const content = `fixture content ${randomUUID()}`;
    const id = await makeRepoFixtureNode(content);
    const before = (await caller().getNodes({ ids: [id] })).nodes[0];
    expect(before?.content).toBe(content);

    const annotation = await caller().annotateNode({ targetNodeId: id, title: "a hand-authored note", content: "annotation body, unrelated to the target" });
    createdNodeIds.push(annotation.noteId);
    createdRunIds.push(annotation.ingestRunId);

    const after = (await caller().getNodes({ ids: [id] })).nodes[0];
    expect(after?.content).toBe(before?.content);
    expect(after?.title).toBe(before?.title);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});

describe("an edited note's new text is searchable (graph-explorer/spec.md, 'Editing an editable node')", () => {
  it("the content updateNodeContent just wrote is what search finds", async () => {
    const created = await caller().createNote({ title: "bd-hmd.6 editable note", content: "original content, nothing distinctive" });
    createdNodeIds.push(created.id);
    createdRunIds.push(created.ingestRunId);

    const marker = `bdhmd6marker${randomUUID().replace(/-/g, "")}`;
    const updated = await caller().updateNodeContent({ nodeId: created.id, content: `revised content mentioning ${marker}` });
    createdRunIds.push(updated.ingestRunId);

    const result = await caller().search({ query: marker });
    expect(result.mode).not.toBe("empty");
    if (result.mode !== "empty") {
      expect(result.nodes.some((n) => n.id === created.id)).toBe(true);
    }
  });
});

describe("a standalone note is findable despite having no edges (graph-explorer/spec.md, 'Creating a standalone note')", () => {
  it("is found by search, reporting degree 0", async () => {
    const marker = `bdhmd6standalone${randomUUID().replace(/-/g, "")}`;
    const created = await caller().createNote({ title: "bd-hmd.6 standalone note", content: `content mentioning ${marker}` });
    createdNodeIds.push(created.id);
    createdRunIds.push(created.ingestRunId);

    const result = await caller().search({ query: marker });
    expect(result.mode).not.toBe("empty");
    if (result.mode !== "empty") {
      const found = result.nodes.find((n) => n.id === created.id);
      expect(found?.degree).toBe(0);
    }
  });

  it("is surfaced by listUnlinkedNotes — the app's own 'discoverable rather than silent' path (design.md)", async () => {
    const created = await caller().createNote({ title: `bd-hmd.6 unlinked ${randomUUID()}` });
    createdNodeIds.push(created.id);
    createdRunIds.push(created.ingestRunId);

    const result = await caller().listUnlinkedNotes();
    expect(result.notes.some((n) => n.id === created.id)).toBe(true);
  });
});

describe("a hand edge's full round trip through the router (graph-explorer/spec.md, 'Connecting two nodes by hand' / 'Reweighting an edge')", () => {
  it("assert -> confirmed via getNeighbors -> reweight -> confirmed -> retract -> confirmed gone", async () => {
    const srcId = await makeRepoFixtureNode("hand-edge fixture src");
    const dstId = await makeRepoFixtureNode("hand-edge fixture dst");
    const edgeType = `bd-hmd6-e2e-relates-to-${randomUUID()}`;

    // Assert, through the router — DetailPanel.tsx's ConnectForm.
    const asserted = await caller().assertEdge({ srcId, dstId, edgeType, weight: 0.65 });
    createdRunIds.push(asserted.ingestRunId);
    expect(asserted.action).toBe("created");

    // Confirmed via getNeighbors — the same read path the canvas uses to
    // draw it: a `human`-sourced edge to dstId at the asserted weight.
    // `weight` is checked separately with `toBeCloseTo`, not folded into
    // the `toMatchObject` above: `edges.weight` is Postgres `real`
    // (float4, packages/db/src/schema.ts), so 0.65 round-trips as
    // 0.6499999761581421 — an exact-equality check on it would be
    // asserting on float4 rounding, not on this router's behaviour.
    const afterAssert = await caller().getNeighbors({ id: srcId });
    const neighborAfterAssert = afterAssert.neighbors.find((n) => n.nodeId === dstId && n.edgeType === edgeType);
    expect(neighborAfterAssert).toMatchObject({ edgeSourceSystem: "human", direction: "outgoing" });
    expect(neighborAfterAssert?.weight).toBeCloseTo(0.65, 5);

    // Reweight, through the router — DetailPanel.tsx's EdgeRow.
    const reweighted = await caller().reweightEdge({ srcId, dstId, edgeType, weight: 0.1 });
    createdRunIds.push(reweighted.ingestRunId);
    expect(reweighted.weight).toBeCloseTo(0.1, 5);

    const afterReweight = await caller().getNeighbors({ id: srcId });
    const neighborAfterReweight = afterReweight.neighbors.find((n) => n.nodeId === dstId && n.edgeType === edgeType);
    expect(neighborAfterReweight?.weight).toBeCloseTo(0.1, 5);

    // Retract, through the router — DetailPanel.tsx's EdgeRow "Retract".
    const retracted = await caller().retractEdge({ srcId, dstId, edgeType });
    expect(retracted.retracted).toBe(true);

    const afterRetract = await caller().getNeighbors({ id: srcId });
    expect(afterRetract.neighbors.some((n) => n.nodeId === dstId && n.edgeType === edgeType)).toBe(false);
  });
});
