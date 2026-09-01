import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { computeContentHash } from "./content-hash.js";
import {
  ContentTooLargeError,
  EdgeNotFoundError,
  InvalidEdgeWeightError,
  InvalidLookupIdError,
  InvalidNodeContentError,
  NodeNotEditableError,
  NodeNotFoundError,
} from "./errors.js";
import { isEditableSourceSystem } from "./editability.js";
import {
  ANNOTATES_EDGE_TYPE,
  HUMAN_SOURCE_SYSTEM,
  NOTE_NODE_TYPE,
  annotateNode,
  assertEdge,
  createNote,
  retractEdge,
  reweightEdge,
  updateNodeContent,
} from "./human-writes.js";
import { closeIngestRun, getIngestRunContents, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertEdges } from "./edges.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

let pool: TestPool;
let db: Database;

// Every fixture this suite creates is torn down by explicit id, never by
// deleting on a shared source_system like "human"/"agent"/"repo" — those
// are literal values this module (and, for "agent"/"repo", other writers
// entirely) legitimately writes under, and the 9-node/16-edge seeded
// corpus lives under source_system='repo'. Deleting "everything with
// source_system='repo'" would destroy it; deleting by id never can.
const createdEdgeIds: string[] = [];
const createdNodeIds: string[] = [];
const createdRunIds: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  if (createdEdgeIds.length > 0) {
    await db.delete(edges).where(inArray(edges.id, createdEdgeIds));
    createdEdgeIds.length = 0;
  }
  if (createdNodeIds.length > 0) {
    // Cascades to any remaining edge attached to one of these nodes
    // (edges.src_id/dst_id are ON DELETE CASCADE) — the explicit edge
    // delete above already covers edges this suite tracked by id, this
    // is a safety net, not the primary mechanism.
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

/** Opens a throwaway ingest run under a unique, test-scoped source_system — for fixtures that stand in for "some loader" or "some agent", never for the human write functions under test. */
async function newFixtureRun(label: string): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, `human-writes-test-${label}-${uniqueSuffix()}`);
  createdRunIds.push(run.id);
  return run;
}

/**
 * Creates one node directly via upsertNodes (bypassing the human write
 * surface) as a fixture — e.g. a stand-in file-backed node to annotate, a
 * real repo/agent-sourced node to exercise the editability whitelist
 * against, or two endpoints to assert a hand-authored edge between.
 *
 * The node's own `sourceSystem` is exactly what's requested (including
 * the literal "repo"/"agent", when a test needs the real whitelist
 * value) — but the *ingest run* it's attributed to always opens under a
 * unique, test-scoped source_system (`newFixtureRun`), never a literal
 * "repo"/"agent". Those two are independent fields (the MCP write tools
 * do the same thing: a single agent-attributed run can write nodes under
 * `sourceSystem: "github"`), and decoupling them here is load-bearing:
 * `apps/mcp/src/server.test.ts` runs, in a separate worker process
 * against this same database, an afterEach sweep that deletes *any*
 * ingest_runs row with `source_system='agent'` and zero counts — which
 * is indistinguishable from a fixture run of ours that hasn't reached
 * `closeIngestRun` yet. A first version of this helper opened the run
 * itself under the literal source_system and hit exactly that race
 * (`nodes_ingest_run_id_ingest_runs_id_fk` violation, the run deleted out
 * from under an in-flight insert).
 */
async function makeFixtureNode(sourceSystem: string, overrides: { content?: string; title?: string } = {}): Promise<{ id: string; externalId: string }> {
  const run = await newFixtureRun(sourceSystem);
  const externalId = sourceSystem === "repo" ? `test-fixtures/hmd2-${uniqueSuffix()}.md` : `fixture-${uniqueSuffix()}`;
  const result = await upsertNodes(db, run, [
    { nodeType: "doc", sourceSystem, externalId, title: overrides.title ?? "Fixture", content: overrides.content ?? "fixture content" },
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("fixture setup failed");
  createdNodeIds.push(row.id);
  return { id: row.id, externalId: row.externalId };
}

describe("editability predicate", () => {
  it("is a whitelist of human/agent, not a blacklist of repo", () => {
    expect(isEditableSourceSystem("human")).toBe(true);
    expect(isEditableSourceSystem("agent")).toBe(true);
    expect(isEditableSourceSystem("repo")).toBe(false);
    expect(isEditableSourceSystem("slack")).toBe(false);
    expect(isEditableSourceSystem("notion")).toBe(false);
  });
});

describe("createNote", () => {
  it("creates a standalone note with no edges, attributed to a human ingest run", async () => {
    const result = await createNote(db, { title: "Standalone", content: "just a note" });
    createdNodeIds.push(result.id);
    createdRunIds.push(result.ingestRunId);

    const [row] = await db.select().from(nodes).where(eq(nodes.id, result.id));
    expect(row?.nodeType).toBe(NOTE_NODE_TYPE);
    expect(row?.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
    expect(row?.content).toBe("just a note");
    expect(row?.ingestRunId).toBe(result.ingestRunId);

    const touching = await db.select({ id: edges.id }).from(edges).where(and(eq(edges.srcId, result.id), eq(edges.edgeType, ANNOTATES_EDGE_TYPE)));
    const touchingDst = await db.select({ id: edges.id }).from(edges).where(eq(edges.dstId, result.id));
    expect(touching).toHaveLength(0);
    expect(touchingDst).toHaveLength(0);
  });

  it("generates a distinct, stable external_id per note — two notes never collide", async () => {
    const a = await createNote(db, { content: "note a" });
    const b = await createNote(db, { content: "note b" });
    createdNodeIds.push(a.id, b.id);
    createdRunIds.push(a.ingestRunId, b.ingestRunId);

    expect(a.externalId).not.toBe(b.externalId);
    expect(a.id).not.toBe(b.id);
  });

  it("rejects oversized content the same way upsertNodes does, and persists nothing", async () => {
    const oversized = "x".repeat(2_000_000);
    await expect(createNote(db, { content: oversized })).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  it("rejects a control character in content the same way upsertNodes does", async () => {
    let thrown: unknown;
    try {
      await createNote(db, { content: `before${String.fromCharCode(0)}after` });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidNodeContentError);
    expect((thrown as InvalidNodeContentError).field).toBe("content");
  });
});

describe("hand-authored content is separable", () => {
  it("a person's note and an agent's node land in distinct, individually-inspectable ingest runs", async () => {
    const note = await createNote(db, { content: "human note content" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);

    // The run itself opens under a unique, test-scoped source_system (see
    // makeFixtureNode's comment on why) — the node it writes still
    // carries the real, literal "agent" source_system, which is the
    // property this test is actually about.
    const agentRun = await newFixtureRun("agent");
    const agentWrite = await upsertNodes(db, agentRun, [
      { nodeType: "doc", sourceSystem: "agent", externalId: `agent-fixture-${uniqueSuffix()}`, content: "agent node content" },
    ]);
    const agentNodeId = agentWrite.rows[0]?.id;
    if (!agentNodeId) throw new Error("setup failed");
    createdNodeIds.push(agentNodeId);
    await closeIngestRun(db, agentRun);

    const noteRunContents = await getIngestRunContents(db, note.ingestRunId);
    expect(noteRunContents.nodes.map((n) => n.id)).toContain(note.id);
    expect(noteRunContents.nodes.map((n) => n.id)).not.toContain(agentNodeId);

    const agentRunContents = await getIngestRunContents(db, agentRun.id);
    expect(agentRunContents.nodes.map((n) => n.id)).toContain(agentNodeId);
    expect(agentRunContents.nodes.map((n) => n.id)).not.toContain(note.id);

    const [noteRow] = await db.select({ sourceSystem: nodes.sourceSystem }).from(nodes).where(eq(nodes.id, note.id));
    const [agentRow] = await db.select({ sourceSystem: nodes.sourceSystem }).from(nodes).where(eq(nodes.id, agentNodeId));
    expect(noteRow?.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
    expect(agentRow?.sourceSystem).toBe("agent");
  });
});

describe("annotateNode", () => {
  it("annotating a file-backed node creates a separate note joined by an edge, leaving the target's content and hash unchanged", async () => {
    const target = await makeFixtureNode("loader-fixture", { title: "Doc title", content: "original file content" });
    const [before] = await db.select({ content: nodes.content, contentHash: nodes.contentHash }).from(nodes).where(eq(nodes.id, target.id));
    expect(before?.contentHash).toBe(computeContentHash("Doc title", "original file content"));

    const result = await annotateNode(db, target.id, { content: "my annotation" });
    createdNodeIds.push(result.noteId);
    createdEdgeIds.push(result.annotationEdgeId);
    createdRunIds.push(result.ingestRunId);

    const [note] = await db.select().from(nodes).where(eq(nodes.id, result.noteId));
    expect(note?.nodeType).toBe(NOTE_NODE_TYPE);
    expect(note?.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
    expect(note?.content).toBe("my annotation");

    const [edge] = await db.select().from(edges).where(eq(edges.id, result.annotationEdgeId));
    expect(edge?.srcId).toBe(result.noteId);
    expect(edge?.dstId).toBe(target.id);
    expect(edge?.edgeType).toBe(ANNOTATES_EDGE_TYPE);
    expect(edge?.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);

    const [after] = await db.select({ content: nodes.content, contentHash: nodes.contentHash }).from(nodes).where(eq(nodes.id, target.id));
    expect(after?.content).toBe(before?.content);
    expect(after?.contentHash).toBe(before?.contentHash);
  });

  it("a failed annotation (missing target) leaves no orphan note behind", async () => {
    // A target id that is syntactically a uuid but doesn't exist: passes
    // the boundary uuid-shape check, so the transaction actually opens
    // and runs its existence check inside it, which throws
    // NodeNotFoundError and aborts the transaction before the note
    // insert — the same all-or-nothing guarantee that protects the
    // (harder to trigger deterministically, since every field the edge
    // insert uses is derived from already-validated data) case where the
    // note insert succeeds but the edge insert fails afterward: either
    // way, the whole db.transaction(...) callback throws, so Postgres
    // rolls back everything the callback did, and no orphan note is ever
    // visible to another transaction.
    const bogusTarget = "00000000-0000-0000-0000-000000000000";

    await expect(annotateNode(db, bogusTarget, { content: "orphan?" })).rejects.toBeInstanceOf(NodeNotFoundError);

    // No note was left behind carrying this call's (unique) content.
    const orphan = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.content, "orphan?"));
    expect(orphan).toHaveLength(0);
  });

  it("rejects a malformed target id before touching the database", async () => {
    await expect(annotateNode(db, "not-a-uuid", { content: "x" })).rejects.toBeInstanceOf(InvalidLookupIdError);
  });

  it("standalone note has no edges (contrast case)", async () => {
    const note = await createNote(db, { content: "no target" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);
    const edgeRows = await db.select({ id: edges.id }).from(edges).where(eq(edges.srcId, note.id));
    expect(edgeRows).toHaveLength(0);
  });
});

describe("seed-survival: annotating a repo node survives a re-seed", () => {
  it("write a node as 'repo', annotate it, re-upsert the same repo node unchanged — it reports unchanged and the annotation/edge still stand", async () => {
    const repoRun = await newFixtureRun("repo");
    const externalId = `test-fixtures/hmd2-seed-survival-${uniqueSuffix()}.md`;
    const repoNodeInput = { nodeType: "doc", sourceSystem: "repo", externalId, title: "Seed doc", content: "unchanged seed content" };

    const firstLoad = await upsertNodes(db, repoRun, [repoNodeInput]);
    const repoNodeId = firstLoad.rows[0]?.id;
    if (!repoNodeId) throw new Error("setup failed");
    createdNodeIds.push(repoNodeId);
    expect(firstLoad.rows[0]?.action).toBe("created");

    const annotation = await annotateNode(db, repoNodeId, { content: "human note on a repo doc" });
    createdNodeIds.push(annotation.noteId);
    createdEdgeIds.push(annotation.annotationEdgeId);
    createdRunIds.push(annotation.ingestRunId);

    // Simulate `pnpm db:seed` re-running over the same, unchanged file:
    // same source_system/external_id/title/content, a fresh ingest run,
    // exactly what seed.ts does on every run.
    const reseedRun = await newFixtureRun("repo");
    const reload = await upsertNodes(db, reseedRun, [repoNodeInput]);
    expect(reload.rows[0]?.action).toBe("unchanged");
    expect(reload.rows[0]?.id).toBe(repoNodeId);

    // The annotation and its edge survived the re-load untouched.
    const [noteStillThere] = await db.select({ id: nodes.id, content: nodes.content }).from(nodes).where(eq(nodes.id, annotation.noteId));
    expect(noteStillThere?.content).toBe("human note on a repo doc");
    const [edgeStillThere] = await db.select().from(edges).where(eq(edges.id, annotation.annotationEdgeId));
    expect(edgeStillThere?.srcId).toBe(annotation.noteId);
    expect(edgeStillThere?.dstId).toBe(repoNodeId);
  });
});

describe("updateNodeContent", () => {
  it("edits a human-authored node's content", async () => {
    const note = await createNote(db, { content: "v1" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);

    const updated = await updateNodeContent(db, note.id, { content: "v2" });
    createdRunIds.push(updated.ingestRunId);
    expect(updated.action).toBe("updated");

    const [row] = await db.select({ content: nodes.content }).from(nodes).where(eq(nodes.id, note.id));
    expect(row?.content).toBe("v2");
  });

  it("edits an agent-authored node's content (the whitelist includes agent, not just human)", async () => {
    const fixture = await makeFixtureNode("agent", { content: "agent v1" });
    const updated = await updateNodeContent(db, fixture.id, { content: "agent v2" });
    createdRunIds.push(updated.ingestRunId);
    expect(updated.action).toBe("updated");
  });

  it("leaves unspecified fields untouched", async () => {
    const note = await createNote(db, { title: "Keep me", content: "v1" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);

    const updated = await updateNodeContent(db, note.id, { content: "v2" });
    createdRunIds.push(updated.ingestRunId);

    const [row] = await db.select({ title: nodes.title, content: nodes.content }).from(nodes).where(eq(nodes.id, note.id));
    expect(row?.title).toBe("Keep me");
    expect(row?.content).toBe("v2");
  });

  it("reports unchanged when the content is identical", async () => {
    const note = await createNote(db, { content: "same" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);

    const updated = await updateNodeContent(db, note.id, { content: "same" });
    createdRunIds.push(updated.ingestRunId);
    expect(updated.action).toBe("unchanged");
  });

  it("refuses to edit a file-backed node, naming the node and its source system", async () => {
    const fixture = await makeFixtureNode("loader-fixture");

    let thrown: unknown;
    try {
      await updateNodeContent(db, fixture.id, { content: "hijacked" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NodeNotEditableError);
    const err = thrown as NodeNotEditableError;
    expect(err.nodeId).toBe(fixture.id);
    expect(err.sourceSystem).toContain("loader-fixture");
    expect(err.message).toContain(fixture.id);

    const [row] = await db.select({ content: nodes.content }).from(nodes).where(eq(nodes.id, fixture.id));
    expect(row?.content).toBe("fixture content");
  });

  it("refuses to edit a real repo-sourced node the same way", async () => {
    const repoRun = await newFixtureRun("repo");
    const externalId = `test-fixtures/hmd2-noedit-${uniqueSuffix()}.md`;
    const result = await upsertNodes(db, repoRun, [{ nodeType: "doc", sourceSystem: "repo", externalId, content: "repo content" }]);
    const repoNodeId = result.rows[0]?.id;
    if (!repoNodeId) throw new Error("setup failed");
    createdNodeIds.push(repoNodeId);

    await expect(updateNodeContent(db, repoNodeId, { content: "hijacked" })).rejects.toBeInstanceOf(NodeNotEditableError);
  });

  it("rejects oversized content on an editable node identically to any other writer", async () => {
    const note = await createNote(db, { content: "small" });
    createdNodeIds.push(note.id);
    createdRunIds.push(note.ingestRunId);

    await expect(updateNodeContent(db, note.id, { content: "x".repeat(2_000_000) })).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  it("throws NodeNotFoundError for a node that does not exist", async () => {
    await expect(updateNodeContent(db, "00000000-0000-0000-0000-000000000000", { content: "x" })).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("rejects a malformed node id before touching the database", async () => {
    await expect(updateNodeContent(db, "not-a-uuid", { content: "x" })).rejects.toBeInstanceOf(InvalidLookupIdError);
  });
});

describe("assertEdge / retractEdge / reweightEdge", () => {
  it("asserting an edge that already exists from the same source is a no-op, not a duplicate or an error", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");

    const first = await assertEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to", weight: 0.5 });
    createdEdgeIds.push(first.id);
    createdRunIds.push(first.ingestRunId);

    const second = await assertEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to", weight: 0.5 });
    createdRunIds.push(second.ingestRunId);
    expect(second.id).toBe(first.id);

    const rows = await db
      .select()
      .from(edges)
      .where(and(eq(edges.srcId, a.id), eq(edges.dstId, b.id), eq(edges.edgeType, "relates-to"), eq(edges.sourceSystem, HUMAN_SOURCE_SYSTEM)));
    expect(rows).toHaveLength(1);
  });

  it("retracting a hand-authored edge leaves a loader's assertion of the same relationship intact", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");
    const loaderSourceSystem = `loader-fixture-${uniqueSuffix()}`;

    const humanAssertion = await assertEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to" });
    createdRunIds.push(humanAssertion.ingestRunId);

    const loaderRun = await newFixtureRun(loaderSourceSystem);
    const loaderAssertion = await upsertEdges(db, loaderRun, [{ srcId: a.id, dstId: b.id, edgeType: "relates-to", sourceSystem: loaderSourceSystem }]);
    const loaderEdgeId = loaderAssertion.rows[0]?.id;
    if (!loaderEdgeId) throw new Error("setup failed");
    createdEdgeIds.push(loaderEdgeId);

    const result = await retractEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to" });
    expect(result.retracted).toBe(true);

    const humanRows = await db
      .select()
      .from(edges)
      .where(and(eq(edges.srcId, a.id), eq(edges.dstId, b.id), eq(edges.edgeType, "relates-to"), eq(edges.sourceSystem, HUMAN_SOURCE_SYSTEM)));
    expect(humanRows).toHaveLength(0);

    const loaderRows = await db.select({ id: edges.id }).from(edges).where(eq(edges.id, loaderEdgeId));
    expect(loaderRows).toHaveLength(1);
  });

  it("retracting an edge that was never asserted by a human is an idempotent no-op, not an error", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");

    const first = await retractEdge(db, { srcId: a.id, dstId: b.id, edgeType: "never-asserted" });
    expect(first.retracted).toBe(false);
    const second = await retractEdge(db, { srcId: a.id, dstId: b.id, edgeType: "never-asserted" });
    expect(second.retracted).toBe(false);
  });

  it("reweights an edge the caller asserted", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");

    const asserted = await assertEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to", weight: 0.2 });
    createdEdgeIds.push(asserted.id);
    createdRunIds.push(asserted.ingestRunId);

    const reweighted = await reweightEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to", weight: 0.9 });
    createdRunIds.push(reweighted.ingestRunId);
    expect(reweighted.weight).toBeCloseTo(0.9);

    const [row] = await db.select({ weight: edges.weight }).from(edges).where(eq(edges.id, asserted.id));
    expect(row?.weight).toBeCloseTo(0.9);
  });

  it("rejects an out-of-range weight, naming the edge, before touching the database", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");
    const asserted = await assertEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to" });
    createdEdgeIds.push(asserted.id);
    createdRunIds.push(asserted.ingestRunId);

    let thrown: unknown;
    try {
      await reweightEdge(db, { srcId: a.id, dstId: b.id, edgeType: "relates-to", weight: 1.5 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidEdgeWeightError);
    const err = thrown as InvalidEdgeWeightError;
    expect(err.srcId).toBe(a.id);
    expect(err.dstId).toBe(b.id);
    expect(err.edgeType).toBe("relates-to");
    expect(err.message).toContain(a.id);

    const [row] = await db.select({ weight: edges.weight }).from(edges).where(eq(edges.id, asserted.id));
    expect(row?.weight).toBeCloseTo(1.0);
  });

  it("throws EdgeNotFoundError reweighting an edge that was never asserted by a human", async () => {
    const a = await makeFixtureNode("edge-fixture");
    const b = await makeFixtureNode("edge-fixture");

    await expect(reweightEdge(db, { srcId: a.id, dstId: b.id, edgeType: "never-asserted", weight: 0.5 })).rejects.toBeInstanceOf(EdgeNotFoundError);
  });
});
