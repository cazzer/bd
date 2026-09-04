import { PgDialect } from "drizzle-orm/pg-core";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, LookupFailedError, NodeNotFoundError } from "./errors.js";
import type { EdgeInput } from "./edges.js";
import { upsertEdges } from "./edges.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import type { NodeInput } from "./nodes.js";
import { upsertNodes } from "./nodes.js";
import {
  buildGetNeighborsQuery,
  buildGetNodesByExternalIdQuery,
  buildGetNodesQuery,
  DEFAULT_NEIGHBOR_LIMIT,
  getNeighbors,
  getNodes,
  getNodesByExternalId,
  MAX_EXTERNAL_ID_LOOKUPS,
  MAX_NEIGHBOR_LIMIT,
  type BuildGetNeighborsQueryParams,
  type ExternalIdPair,
  type NeighborsCursor,
} from "./lookup.js";
import { retrieve } from "./retrieval.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
const openRunIds: string[] = [];
const usedSourceSystems: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  if (usedSourceSystems.length > 0) {
    await db.delete(edges).where(inArray(edges.sourceSystem, usedSourceSystems));
    await db.delete(nodes).where(inArray(nodes.sourceSystem, usedSourceSystems));
    usedSourceSystems.length = 0;
  }
  if (openRunIds.length > 0) {
    await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRunIds));
    openRunIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

async function newRun(): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, `lookup-test-${uniqueSuffix()}`);
  openRunIds.push(run.id);
  usedSourceSystems.push(run.sourceSystem);
  return run;
}

async function makeNodes(run: IngestRunHandle, specs: readonly Omit<NodeInput, "sourceSystem">[]): Promise<Map<string, string>> {
  const input: NodeInput[] = specs.map((s) => ({ ...s, sourceSystem: run.sourceSystem }));
  const result = await upsertNodes(db, run, input);
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

async function makeEdges(run: IngestRunHandle, specs: readonly Omit<EdgeInput, "sourceSystem">[]): Promise<void> {
  const input: EdgeInput[] = specs.map((e) => ({ ...e, sourceSystem: run.sourceSystem }));
  await upsertEdges(db, run, input);
}

const BOGUS_ID = "00000000-0000-0000-0000-000000000000";

// --- buildGetNodesQuery / buildGetNeighborsQuery: pure functions -----------

describe("buildGetNodesQuery", () => {
  const dialect = new PgDialect();

  it("is pure: the same ids produce identical SQL text and params on every call", () => {
    const ids = [BOGUS_ID, "11111111-1111-1111-1111-111111111111"];
    const a = dialect.sqlToQuery(buildGetNodesQuery(ids));
    const b = dialect.sqlToQuery(buildGetNodesQuery(ids));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });

  it("contains no semicolon — it is exactly one statement", () => {
    const { sql: text } = dialect.sqlToQuery(buildGetNodesQuery([BOGUS_ID]));
    expect(text).not.toContain(";");
  });

  it("resolves through resolved_nodes, not nodes directly, so a merged-away row cannot leak through", () => {
    const { sql: text } = dialect.sqlToQuery(buildGetNodesQuery([BOGUS_ID]));
    expect(text).toContain("resolved_nodes");
  });
});

describe("buildGetNeighborsQuery", () => {
  const dialect = new PgDialect();
  const baseParams = { id: BOGUS_ID, limit: 25, cursor: null };

  it("is pure: the same params produce identical SQL text and params on every call", () => {
    const a = dialect.sqlToQuery(buildGetNeighborsQuery(baseParams));
    const b = dialect.sqlToQuery(buildGetNeighborsQuery(baseParams));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });

  it("contains no semicolon — it is exactly one statement", () => {
    const { sql: text } = dialect.sqlToQuery(buildGetNeighborsQuery(baseParams));
    expect(text).not.toContain(";");
  });

  it("excludes the self-loop guard's canonical id, mirroring result_edges in retrieval.ts", () => {
    const { sql: text } = dialect.sqlToQuery(buildGetNeighborsQuery(baseParams));
    expect(text).toContain("other_id <>");
  });

  it("renders a literal NULL for an unset cursor and a bound parameter for a set one — same nullable-filter convention as retrieval.ts's nodeTypes/updatedSince", () => {
    const unset = dialect.sqlToQuery(buildGetNeighborsQuery(baseParams));
    expect(unset.sql).toContain("NULL::double precision");
    expect(unset.sql).toContain("NULL::uuid");

    const withCursor = { id: BOGUS_ID, limit: 10, cursor: { canonicalId: BOGUS_ID, weight: 0.5, nodeId: BOGUS_ID, edgeId: BOGUS_ID } };
    const cursored = dialect.sqlToQuery(buildGetNeighborsQuery(withCursor));
    expect(cursored.sql).not.toContain("NULL::double precision");
    expect(cursored.params).toContain(0.5);
  });
});

// --- getNodes: one test per brain_get requirement ---------------------------

describe("getNodes", () => {
  it("returns full content for existing ids", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Title one", content: "Content one", metadata: { k: "v" } },
      { nodeType: "doc", externalId: "n2", title: "Title two", content: "Content two" },
    ]);
    const id1 = nodeMap.get("n1")!;
    const id2 = nodeMap.get("n2")!;

    const result = await getNodes(db, [id1, id2]);

    expect(result.notFoundIds).toEqual([]);
    expect(result.nodes).toHaveLength(2);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get(id1)).toMatchObject({
      nodeType: "doc",
      sourceSystem: run.sourceSystem,
      externalId: "n1",
      title: "Title one",
      content: "Content one",
      metadata: { k: "v" },
      requestedIds: [id1],
    });
    expect(byId.get(id1)!.createdAt).toBeInstanceOf(Date);
    expect(byId.get(id1)!.updatedAt).toBeInstanceOf(Date);
    expect(byId.get(id2)).toMatchObject({ externalId: "n2", title: "Title two", content: "Content two" });
  });

  it("resolves an id naming a merged-away node to its survivor's content (spec: merge semantics)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "survivor content" },
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "loser content" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNodes(db, [loserId]);

    expect(result.notFoundIds).toEqual([]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe(survivorId);
    expect(result.nodes[0]!.title).toBe("Survivor");
    expect(result.nodes[0]!.requestedIds).toEqual([loserId]);
  });

  it("reports an id matching nothing in notFoundIds, rather than silently omitting it", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "T", content: "C" }]);
    const id1 = nodeMap.get("n1")!;

    const result = await getNodes(db, [id1, BOGUS_ID]);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe(id1);
    expect(result.notFoundIds).toEqual([BOGUS_ID]);
  });

  it("collapses a loser and its survivor requested together into one entry carrying both requested ids", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "c" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNodes(db, [loserId, survivorId]);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe(survivorId);
    expect(new Set(result.nodes[0]!.requestedIds)).toEqual(new Set([loserId, survivorId]));
    expect(result.notFoundIds).toEqual([]);
  });

  it("rejects an empty ids array with InvalidLookupIdError, before any SQL runs", async () => {
    await expect(getNodes(db, [])).rejects.toBeInstanceOf(InvalidLookupIdError);
  });

  it("rejects a malformed (non-uuid) id with InvalidLookupIdError", async () => {
    await expect(getNodes(db, ["not-a-uuid"])).rejects.toBeInstanceOf(InvalidLookupIdError);
  });

  it("stores and returns SQL-looking content as literal text, never executing it", async () => {
    const run = await newRun();
    const maliciousTitle = "Robert'); DROP TABLE nodes;--";
    const maliciousContent = "1'; DELETE FROM nodes WHERE '1'='1";
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: maliciousTitle, content: maliciousContent }]);
    const id1 = nodeMap.get("n1")!;

    const result = await getNodes(db, [id1]);

    expect(result.nodes[0]!.title).toBe(maliciousTitle);
    expect(result.nodes[0]!.content).toBe(maliciousContent);
    // If the string had been executed rather than stored as literal text,
    // the nodes table (and this very row) would be gone.
    const stillThere = await getNodes(db, [id1]);
    expect(stillThere.nodes).toHaveLength(1);
  });
});

// --- getNeighbors: one test per brain_neighbors requirement ------------------

describe("getNeighbors", () => {
  it("returns adjacent nodes with edge type, direction, weight, and source system, for both outgoing and incoming edges", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "Center", content: "c" },
      { nodeType: "doc", externalId: "out-nbr", title: "Out neighbor", content: "c" },
      { nodeType: "doc", externalId: "in-nbr", title: "In neighbor", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const outId = nodeMap.get("out-nbr")!;
    const inId = nodeMap.get("in-nbr")!;
    await makeEdges(run, [
      { srcId: centerId, dstId: outId, edgeType: "mentions", weight: 0.9 },
      { srcId: inId, dstId: centerId, edgeType: "cites", weight: 0.4 },
    ]);

    const result = await getNeighbors(db, centerId);

    expect(result.requestedId).toBe(centerId);
    expect(result.canonicalId).toBe(centerId);
    expect(result.neighbors).toHaveLength(2);

    const outgoing = result.neighbors.find((n) => n.nodeId === outId);
    expect(outgoing).toMatchObject({
      direction: "outgoing",
      edgeType: "mentions",
      edgeSourceSystem: run.sourceSystem,
      nodeType: "doc",
      nodeSourceSystem: run.sourceSystem,
      externalId: "out-nbr",
      title: "Out neighbor",
    });
    // `real` -> `double precision` cast can introduce float32 rounding
    // (same reason edges.test.ts uses toBeCloseTo, not toBe, for weight).
    expect(outgoing!.weight).toBeCloseTo(0.9);
    expect(outgoing!.edgeId).toBeTruthy();

    const incoming = result.neighbors.find((n) => n.nodeId === inId);
    expect(incoming).toMatchObject({ direction: "incoming", edgeType: "cites", externalId: "in-nbr" });
    expect(incoming!.weight).toBeCloseTo(0.4);
  });

  it("folds an edge attached to a merged-away alias onto the survivor, so it is still visible from the survivor's neighbors", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "c" },
      { nodeType: "doc", externalId: "far", title: "Far", content: "c" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    const farId = nodeMap.get("far")!;
    // The edge is asserted on the loser BEFORE the merge — it must still
    // surface as the survivor's neighbor afterward.
    await makeEdges(run, [{ srcId: loserId, dstId: farId, edgeType: "relates_to", weight: 0.7 }]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, survivorId);

    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]).toMatchObject({ nodeId: farId, direction: "outgoing", edgeType: "relates_to" });
  });

  it("resolves a query on the merged-away id itself to the survivor's neighbor set", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "c" },
      { nodeType: "doc", externalId: "far", title: "Far", content: "c" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    const farId = nodeMap.get("far")!;
    await makeEdges(run, [{ srcId: survivorId, dstId: farId, edgeType: "relates_to", weight: 0.5 }]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, loserId);

    expect(result.requestedId).toBe(loserId);
    expect(result.canonicalId).toBe(survivorId);
    expect(result.neighbors.map((n) => n.nodeId)).toEqual([farId]);
  });

  it("excludes a merge-induced self-loop: a loser-to-survivor edge must not appear as the survivor's own neighbor", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "c" },
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "c" },
    ]);
    const loserId = nodeMap.get("loser")!;
    const survivorId = nodeMap.get("survivor")!;
    await makeEdges(run, [{ srcId: loserId, dstId: survivorId, edgeType: "mentions", weight: 0.9 }]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, survivorId);

    expect(result.neighbors.some((n) => n.nodeId === survivorId)).toBe(false);
    expect(result.neighbors).toEqual([]);
  });

  it("resolves a merged-away neighbor to its own survivor (folds the far endpoint too, not just the queried node)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "Center", content: "c" },
      { nodeType: "doc", externalId: "nbr-loser", title: "Neighbor loser", content: "c" },
      { nodeType: "doc", externalId: "nbr-survivor", title: "Neighbor survivor", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const nbrLoserId = nodeMap.get("nbr-loser")!;
    const nbrSurvivorId = nodeMap.get("nbr-survivor")!;
    await makeEdges(run, [{ srcId: centerId, dstId: nbrLoserId, edgeType: "mentions", weight: 0.6 }]);
    await mergeNodes(db, nbrLoserId, nbrSurvivorId, run);

    const result = await getNeighbors(db, centerId);

    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]!.nodeId).toBe(nbrSurvivorId);
    expect(result.neighbors[0]!.externalId).toBe("nbr-survivor");
  });

  it("sorts neighbors by weight descending, then edge id, for deterministic truncation at the caller", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [{ nodeType: "doc", externalId: "hub", title: "Hub", content: "c" }];
    for (let i = 1; i <= 5; i++) specs.push({ nodeType: "doc", externalId: `nbr${i}`, title: `Neighbor ${i}`, content: "c" });
    const nodeMap = await makeNodes(run, specs);
    const hubId = nodeMap.get("hub")!;
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 5; i++) edgeSpecs.push({ srcId: hubId, dstId: nodeMap.get(`nbr${i}`)!, edgeType: "e", weight: i / 5 });
    await makeEdges(run, edgeSpecs);

    const result = await getNeighbors(db, hubId);
    const weights = result.neighbors.map((n) => n.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("rejects a nonexistent id with NodeNotFoundError", async () => {
    await expect(getNeighbors(db, BOGUS_ID)).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("rejects a malformed (non-uuid) id with InvalidLookupIdError", async () => {
    await expect(getNeighbors(db, "not-a-uuid")).rejects.toBeInstanceOf(InvalidLookupIdError);
  });
});

// --- getNeighbors: degree (bd-hmd.5 review) --------------------------------
//
// bd-hmd.5's expansion draws a node reached by getNeighbors at a radius
// derived from its degree. Before this, `Neighbor` carried none, so an
// expanded node drew at the floor radius even when the very same node,
// reached instead by search, drew at its true size — a direct violation
// of graph-explorer/spec.md's "Size is stable across views" ("a node
// SHALL be drawn at the same size wherever it appears"). These mirror
// retrieval.ts's own degree tests (bd-hmd.1) shape-for-shape, since this
// is the identical aggregate applied to a neighbor instead of a
// traversal-kept node — see buildGetNeighborsQuery's "degree" CTE
// comment for the derivation.

describe("getNeighbors — degree (bd-hmd.5 review)", () => {
  it("counts a neighbor's degree across the whole store, not just its edge to the queried node (spec: Size is stable across views)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "Degree-neighbor center", content: "c" },
      { nodeType: "doc", externalId: "spoke", title: "Degree-neighbor spoke", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const spokeId = nodeMap.get("spoke")!;
    const farSpecs: Omit<NodeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 19; i++) farSpecs.push({ nodeType: "doc", externalId: `far${i}`, title: `Far ${i}`, content: "c" });
    const farMap = await makeNodes(run, farSpecs);

    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [{ srcId: centerId, dstId: spokeId, edgeType: "mentions", weight: 0.9 }];
    for (let i = 1; i <= 19; i++) edgeSpecs.push({ srcId: spokeId, dstId: farMap.get(`far${i}`)!, edgeType: "relates_to", weight: 0.5 });
    await makeEdges(run, edgeSpecs);

    const result = await getNeighbors(db, centerId);
    expect(result.neighbors).toHaveLength(1);
    // spoke's degree is center (1) + 19 far nodes (19) = 20 — none of
    // those 19 far nodes are themselves center's neighbors (they aren't
    // in this listing at all), yet the reported degree still counts them.
    expect(result.neighbors[0]!.degree).toBe(20);
  });

  it("counts distinct connected nodes, not edges — a neighbor joined to a third node by three differently-typed/-directed edges still contributes 1 to that neighbor's degree", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "c", content: "c" },
      { nodeType: "doc", externalId: "spoke", title: "s", content: "c" },
      { nodeType: "doc", externalId: "third", title: "t", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const spokeId = nodeMap.get("spoke")!;
    const thirdId = nodeMap.get("third")!;
    await makeEdges(run, [
      { srcId: centerId, dstId: spokeId, edgeType: "mentions", weight: 0.9 },
      { srcId: spokeId, dstId: thirdId, edgeType: "type-a", weight: 0.5 },
      { srcId: spokeId, dstId: thirdId, edgeType: "type-b", weight: 0.4 },
      { srcId: thirdId, dstId: spokeId, edgeType: "type-c", weight: 0.3 },
    ]);

    const result = await getNeighbors(db, centerId);
    const spoke = result.neighbors.find((n) => n.nodeId === spokeId)!;
    // center (1) + third (1, despite three edges across both directions) = 2, not 4.
    expect(spoke.degree).toBe(2);
  });

  it("counts across a merge, once per distinct far node, when the merged-away node had connections the survivor did not", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "c", content: "c" },
      { nodeType: "doc", externalId: "survivor", title: "s", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "l", content: "c" },
      { nodeType: "doc", externalId: "farA", title: "a", content: "c" },
      { nodeType: "doc", externalId: "farB", title: "b", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    const farAId = nodeMap.get("farA")!;
    const farBId = nodeMap.get("farB")!;
    await makeEdges(run, [
      { srcId: centerId, dstId: survivorId, edgeType: "mentions", weight: 0.9 },
      { srcId: survivorId, dstId: farAId, edgeType: "rel", weight: 0.9 },
      { srcId: loserId, dstId: farAId, edgeType: "rel2", weight: 0.8 }, // same farA, from the about-to-be-merged loser
      { srcId: loserId, dstId: farBId, edgeType: "rel3", weight: 0.7 },
    ]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, centerId);
    const survivor = result.neighbors.find((n) => n.nodeId === survivorId)!;
    // center (1) + farA (1, not 2) + farB (1) = 3.
    expect(survivor.degree).toBe(3);
  });

  it("does not count a merge-induced self-connection in a neighbor's own degree", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "c", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "l", content: "c" },
      { nodeType: "doc", externalId: "survivor", title: "s", content: "c" },
      { nodeType: "doc", externalId: "farC", title: "f", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const loserId = nodeMap.get("loser")!;
    const survivorId = nodeMap.get("survivor")!;
    const farCId = nodeMap.get("farC")!;
    await makeEdges(run, [
      { srcId: centerId, dstId: survivorId, edgeType: "mentions", weight: 0.9 },
      { srcId: loserId, dstId: survivorId, edgeType: "self-ish", weight: 0.9 }, // becomes a self-loop once merged
      { srcId: survivorId, dstId: farCId, edgeType: "rel", weight: 0.5 },
    ]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, centerId);
    const survivor = result.neighbors.find((n) => n.nodeId === survivorId)!;
    // center (1) + farC (1) = 2 — NOT 3, which would mean the folded
    // loser->survivor edge counted survivor as connected to itself.
    expect(survivor.degree).toBe(2);
  });

  it("(regression) a far node reached via both the neighbor's own edge and its merged-away alias's edge counts once toward that neighbor's degree", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "c", content: "c" },
      { nodeType: "doc", externalId: "survivor", title: "s", content: "c" },
      { nodeType: "doc", externalId: "loser", title: "l", content: "c" },
      { nodeType: "doc", externalId: "far", title: "f", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    const farId = nodeMap.get("far")!;
    await makeEdges(run, [
      { srcId: centerId, dstId: survivorId, edgeType: "mentions", weight: 0.9 },
      { srcId: survivorId, dstId: farId, edgeType: "rel", weight: 0.8 },
      { srcId: loserId, dstId: farId, edgeType: "rel2", weight: 0.6 },
    ]);
    await mergeNodes(db, loserId, survivorId, run);

    const result = await getNeighbors(db, centerId);
    const survivor = result.neighbors.find((n) => n.nodeId === survivorId)!;
    expect(survivor.degree).toBe(2); // center + far, not center + far + far
  });

  // --- the assertion that actually closes the spec scenario -----------------

  it("agrees with retrieve()'s degree for the SAME node, whether it is reached by search or by expansion (graph-explorer/spec.md, \"Size is stable across views\": a node SHALL be drawn at the same size wherever it appears)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "Degree agreement center unique phrase zeta", content: "c" },
      { nodeType: "doc", externalId: "hub", title: "Degree agreement hub", content: "c" },
    ]);
    const centerId = nodeMap.get("center")!;
    const hubId = nodeMap.get("hub")!;
    const farSpecs: Omit<NodeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 5; i++) farSpecs.push({ nodeType: "doc", externalId: `far${i}`, title: `Far ${i}`, content: "c" });
    const farMap = await makeNodes(run, farSpecs);
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [{ srcId: centerId, dstId: hubId, edgeType: "mentions", weight: 0.9 }];
    for (let i = 1; i <= 5; i++) edgeSpecs.push({ srcId: hubId, dstId: farMap.get(`far${i}`)!, edgeType: "rel", weight: 0.5 });
    await makeEdges(run, edgeSpecs);

    // hub, reached via retrieve() — a search whose seed is "center", traversing to hub...
    const searchResult = await retrieve(db, "degree agreement center zeta", { sourceSystems: [run.sourceSystem] });
    if (searchResult.mode === "empty") throw new Error("expected a found result");
    const hubViaSearch = searchResult.nodes.find((n) => n.id === hubId)!;

    // ...and the SAME hub, reached via getNeighbors(center) — an expansion.
    const neighborsResult = await getNeighbors(db, centerId);
    const hubViaExpansion = neighborsResult.neighbors.find((n) => n.nodeId === hubId)!;

    expect(hubViaSearch.degree).toBe(6); // center + 5 far
    expect(hubViaExpansion.degree).toBe(hubViaSearch.degree); // the two aggregates must never disagree
  });

  it("(regression) resolves the degree aggregate via index scans on edges/nodes, not sequential scans, confirmed with EXPLAIN (ANALYZE, BUFFERS) — the neighbor query is on the click path, run far more often than search", async () => {
    const run = await newRun();
    const NEIGHBOR_COUNT = 50;
    const specs: Omit<NodeInput, "sourceSystem">[] = [{ nodeType: "doc", externalId: "hub", title: "Degree index hub", content: "c" }];
    for (let i = 1; i <= NEIGHBOR_COUNT; i++) specs.push({ nodeType: "doc", externalId: `dnbr${i}`, title: `Degree index neighbor ${i}`, content: "c" });
    const nodeMap = await makeNodes(run, specs);
    const hubId = nodeMap.get("hub")!;
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= NEIGHBOR_COUNT; i++) edgeSpecs.push({ srcId: hubId, dstId: nodeMap.get(`dnbr${i}`)!, edgeType: "hub_edge", weight: i / NEIGHBOR_COUNT });
    await makeEdges(run, edgeSpecs);

    // One neighbor gets a merged-away alias, so the plan also exercises
    // the nodes_merged_into_idx join the degree CTE's alias resolution
    // (neighbor_alias) needs — not just the plain edges lookups.
    const loserMap = await makeNodes(run, [{ nodeType: "doc", externalId: "alias-loser", title: "l", content: "c" }]);
    await mergeNodes(db, loserMap.get("alias-loser")!, nodeMap.get("dnbr1")!, run);

    const params: BuildGetNeighborsQueryParams = { id: hubId, limit: DEFAULT_NEIGHBOR_LIMIT, cursor: null };

    await db.transaction(async (tx) => {
      // Same technique retrieval.ts's own degree EXPLAIN test uses: forces
      // the planner off sequential scans wherever an index exists, so
      // this holds deterministically regardless of the live table's size
      // at test time.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explain = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (ANALYZE, BUFFERS) ${buildGetNeighborsQuery(params)}`);
      const planText = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(planText).not.toContain("Seq Scan");
      expect(planText).toContain("edges_src_id_edge_type_idx");
      expect(planText).toContain("edges_dst_id_edge_type_idx");
      expect(planText).toContain("nodes_merged_into_idx");
      expect(planText).toContain("nodes_pkey");
    });
  });
});

// --- getNeighbors: bounded and ordered (bd-hmd.1) ---------------------------

describe("getNeighbors — bounded and ordered", () => {
  /** Builds a hub with `count` neighbors, each edge weight distinct (`i / count`) so the weight order is unambiguous. */
  async function makeDistinctWeightHub(run: IngestRunHandle, count: number, prefix: string): Promise<{ hubId: string; nodeMap: Map<string, string> }> {
    const specs: Omit<NodeInput, "sourceSystem">[] = [{ nodeType: "doc", externalId: `${prefix}-hub`, title: "Hub", content: "c" }];
    for (let i = 1; i <= count; i++) specs.push({ nodeType: "doc", externalId: `${prefix}-n${i}`, title: `Neighbor ${i}`, content: "c" });
    const nodeMap = await makeNodes(run, specs);
    const hubId = nodeMap.get(`${prefix}-hub`)!;
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= count; i++) {
      edgeSpecs.push({ srcId: hubId, dstId: nodeMap.get(`${prefix}-n${i}`)!, edgeType: "e", weight: i / count });
    }
    await makeEdges(run, edgeSpecs);
    return { hubId, nodeMap };
  }

  it("caps a 500-neighbour hub at a limit of 25, returning exactly the 25 highest-weighted neighbours, and reports more exist (spec: A hub with more neighbours than the limit)", async () => {
    const run = await newRun();
    const COUNT = 500;
    const { hubId, nodeMap } = await makeDistinctWeightHub(run, COUNT, "big");

    const result = await getNeighbors(db, hubId, { limit: 25 });

    expect(result.neighbors).toHaveLength(25);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    const expectedTop25 = new Set(Array.from({ length: 25 }, (_, i) => nodeMap.get(`big-n${COUNT - i}`)!)); // n500..n476: highest weights
    expect(new Set(result.neighbors.map((n) => n.nodeId))).toEqual(expectedTop25);

    // Omitting `limit` uses DEFAULT_NEIGHBOR_LIMIT, which is also 25.
    expect(DEFAULT_NEIGHBOR_LIMIT).toBe(25);
    const withDefault = await getNeighbors(db, hubId);
    expect(withDefault.neighbors).toHaveLength(DEFAULT_NEIGHBOR_LIMIT);
    expect(withDefault.neighbors.map((n) => n.nodeId)).toEqual(result.neighbors.map((n) => n.nodeId));
  });

  it("orders tied weights deterministically by node id, so repeated identical requests return the same neighbours in the same order (spec: Equal weights order deterministically)", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [{ nodeType: "doc", externalId: "tie-hub", title: "Hub", content: "c" }];
    for (let i = 1; i <= 30; i++) specs.push({ nodeType: "doc", externalId: `tie-n${i}`, title: `Neighbor ${i}`, content: "c" });
    const nodeMap = await makeNodes(run, specs);
    const hubId = nodeMap.get("tie-hub")!;
    // Every edge shares the same weight — the limit (10) falls squarely among the ties.
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 30; i++) edgeSpecs.push({ srcId: hubId, dstId: nodeMap.get(`tie-n${i}`)!, edgeType: "e", weight: 0.5 });
    await makeEdges(run, edgeSpecs);

    const first = await getNeighbors(db, hubId, { limit: 10 });
    const second = await getNeighbors(db, hubId, { limit: 10 });

    expect(first.neighbors).toHaveLength(10);
    expect(first.neighbors.map((n) => n.nodeId)).toEqual(second.neighbors.map((n) => n.nodeId));
    // The tie-break is node id ascending.
    const allNeighborIds = Array.from({ length: 30 }, (_, i) => nodeMap.get(`tie-n${i + 1}`)!).sort();
    expect(first.neighbors.map((n) => n.nodeId)).toEqual(allNeighborIds.slice(0, 10));
  });

  it("fetches the remainder via nextCursor with no neighbour repeated or skipped, matching the single-page ground truth in order (spec: Fetching the remainder)", async () => {
    const run = await newRun();
    const COUNT = 60;
    const { hubId } = await makeDistinctWeightHub(run, COUNT, "page");

    const groundTruth = await getNeighbors(db, hubId, { limit: COUNT });
    expect(groundTruth.hasMore).toBe(false);
    expect(groundTruth.neighbors).toHaveLength(COUNT);

    const collected: string[] = [];
    let cursor: NeighborsCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = await getNeighbors(db, hubId, { limit: 17, cursor });
      collected.push(...page.neighbors.map((n) => n.nodeId));
      pages++;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
      if (pages > COUNT) throw new Error("pagination did not terminate");
    }

    expect(collected).toHaveLength(COUNT);
    expect(new Set(collected).size).toBe(COUNT); // no repeats
    expect(collected).toEqual(groundTruth.neighbors.map((n) => n.nodeId)); // same order, nothing skipped
  });

  it("reports none withheld when a node has fewer neighbours than the limit (spec: Fewer neighbours than the limit)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "hub", title: "Hub", content: "c" },
      { nodeType: "doc", externalId: "n1", title: "N1", content: "c" },
      { nodeType: "doc", externalId: "n2", title: "N2", content: "c" },
      { nodeType: "doc", externalId: "n3", title: "N3", content: "c" },
    ]);
    const hubId = nodeMap.get("hub")!;
    await makeEdges(run, [
      { srcId: hubId, dstId: nodeMap.get("n1")!, edgeType: "e", weight: 0.9 },
      { srcId: hubId, dstId: nodeMap.get("n2")!, edgeType: "e", weight: 0.5 },
      { srcId: hubId, dstId: nodeMap.get("n3")!, edgeType: "e", weight: 0.1 },
    ]);

    const result = await getNeighbors(db, hubId, { limit: 25 });

    expect(result.neighbors).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects a non-positive limit with InvalidLookupOptionError, before any SQL runs", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "N1", content: "c" }]);
    await expect(getNeighbors(db, nodeMap.get("n1")!, { limit: 0 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getNeighbors(db, nodeMap.get("n1")!, { limit: -5 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getNeighbors(db, nodeMap.get("n1")!, { limit: 1.5 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });

  it("rejects a malformed cursor with InvalidLookupOptionError", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "N1", content: "c" }]);
    const id = nodeMap.get("n1")!;
    // @ts-expect-error deliberately malformed for the runtime check
    await expect(getNeighbors(db, id, { cursor: { weight: 0.5 } })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(
      getNeighbors(db, id, { cursor: { canonicalId: id, weight: 0.5, nodeId: "not-a-uuid", edgeId: BOGUS_ID } }),
    ).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(
      getNeighbors(db, id, { cursor: { canonicalId: id, weight: Number.NaN, nodeId: BOGUS_ID, edgeId: BOGUS_ID } }),
    ).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(
      getNeighbors(db, id, { cursor: { canonicalId: "not-a-uuid", weight: 0.5, nodeId: BOGUS_ID, edgeId: BOGUS_ID } }),
    ).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });

  // --- bd-hmd.1 review: must-fix 1 — limit has no upper bound -------------

  it("rejects a limit above MAX_NEIGHBOR_LIMIT with InvalidLookupOptionError, before any SQL runs — an unbounded limit overflows Postgres int4 (limit + 1) and would otherwise leak the whole query (comments included) in LookupFailedError.cause", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "N1", content: "c" }]);
    const id = nodeMap.get("n1")!;

    await expect(getNeighbors(db, id, { limit: MAX_NEIGHBOR_LIMIT + 1 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    // The overflow value from the review: 2^31 - 1, Postgres int4's max.
    await expect(getNeighbors(db, id, { limit: 2147483647 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    // A limit at the ceiling is still accepted.
    await expect(getNeighbors(db, id, { limit: MAX_NEIGHBOR_LIMIT })).resolves.toBeDefined();
  });

  // --- bd-hmd.1 review: must-fix 2 — an unbound cursor can be replayed against the wrong node ---

  it("rejects a cursor minted for a different node with InvalidLookupOptionError, rather than silently applying its keyset filter and dropping neighbours (bd-hmd.5's per-node pagination state can hold a stale cursor after the selected node changes)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "hubA", title: "Hub A", content: "c" },
      { nodeType: "doc", externalId: "hubB", title: "Hub B", content: "c" },
      { nodeType: "doc", externalId: "a1", title: "A1", content: "c" },
      { nodeType: "doc", externalId: "a2", title: "A2", content: "c" },
      { nodeType: "doc", externalId: "b1", title: "B1", content: "c" }, // highest weight on B — must not be dropped
      { nodeType: "doc", externalId: "b2", title: "B2", content: "c" },
    ]);
    const hubAId = nodeMap.get("hubA")!;
    const hubBId = nodeMap.get("hubB")!;
    await makeEdges(run, [
      { srcId: hubAId, dstId: nodeMap.get("a1")!, edgeType: "e", weight: 0.9 },
      { srcId: hubAId, dstId: nodeMap.get("a2")!, edgeType: "e", weight: 0.1 },
      { srcId: hubBId, dstId: nodeMap.get("b1")!, edgeType: "e", weight: 1.0 },
      { srcId: hubBId, dstId: nodeMap.get("b2")!, edgeType: "e", weight: 0.2 },
    ]);

    const pageA = await getNeighbors(db, hubAId, { limit: 1 });
    expect(pageA.hasMore).toBe(true);
    expect(pageA.nextCursor).not.toBeNull();
    const staleCursor = pageA.nextCursor!;
    expect(staleCursor.canonicalId).toBe(hubAId);

    // Replaying hub A's cursor against hub B must fail loudly, not
    // silently filter B's neighbors by A's weight (which would drop B's
    // weight-1.0 neighbour with no error and hasMore: false).
    await expect(getNeighbors(db, hubBId, { limit: 1, cursor: staleCursor })).rejects.toBeInstanceOf(InvalidLookupOptionError);

    // Sanity: without the stale cursor, B's own top neighbour is returned correctly.
    const freshB = await getNeighbors(db, hubBId, { limit: 1 });
    expect(freshB.neighbors[0]!.nodeId).toBe(nodeMap.get("b1")!);
  });

  // --- bd-hmd.1 review: regression coverage requested for guarantees with no guard ---

  it("(regression) ties spanning multiple page boundaries: a 10-way tie block paged 3-at-a-time collects every neighbour exactly once, in the same order as a single unpaged fetch", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [{ nodeType: "doc", externalId: "tie-hub2", title: "Hub", content: "c" }];
    for (let i = 1; i <= 10; i++) specs.push({ nodeType: "doc", externalId: `tie2-n${i}`, title: `Neighbor ${i}`, content: "c" });
    const nodeMap = await makeNodes(run, specs);
    const hubId = nodeMap.get("tie-hub2")!;
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 10; i++) edgeSpecs.push({ srcId: hubId, dstId: nodeMap.get(`tie2-n${i}`)!, edgeType: "e", weight: 0.5 });
    await makeEdges(run, edgeSpecs);

    const groundTruth = await getNeighbors(db, hubId, { limit: 10 });
    expect(groundTruth.hasMore).toBe(false);
    expect(groundTruth.neighbors).toHaveLength(10);

    const collected: string[] = [];
    let cursor: NeighborsCursor | null = null;
    let pageCount = 0;
    for (;;) {
      // Page size 3 against a 10-way tie: boundaries fall at 3/6/9, so
      // every page but the last splits the tied block mid-tie.
      const page = await getNeighbors(db, hubId, { limit: 3, cursor });
      collected.push(...page.neighbors.map((n) => n.nodeId));
      pageCount++;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      if (pageCount > 10) throw new Error("pagination did not terminate");
    }

    expect(pageCount).toBe(4); // 3 + 3 + 3 + 1
    expect(collected).toHaveLength(10);
    expect(new Set(collected).size).toBe(10);
    expect(collected).toEqual(groundTruth.neighbors.map((n) => n.nodeId));
  });

  it("(regression) a cursor pointing past a since-deleted edge still paginates correctly — the keyset predicate compares values, not row existence", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "del-hub", title: "Hub", content: "c" },
      { nodeType: "doc", externalId: "d1", title: "D1", content: "c" },
      { nodeType: "doc", externalId: "d2", title: "D2", content: "c" },
      { nodeType: "doc", externalId: "d3", title: "D3", content: "c" },
      { nodeType: "doc", externalId: "d4", title: "D4", content: "c" },
    ]);
    const hubId = nodeMap.get("del-hub")!;
    await makeEdges(run, [
      { srcId: hubId, dstId: nodeMap.get("d1")!, edgeType: "e", weight: 0.9 },
      { srcId: hubId, dstId: nodeMap.get("d2")!, edgeType: "e", weight: 0.7 },
      { srcId: hubId, dstId: nodeMap.get("d3")!, edgeType: "e", weight: 0.5 },
      { srcId: hubId, dstId: nodeMap.get("d4")!, edgeType: "e", weight: 0.3 },
    ]);

    const page1 = await getNeighbors(db, hubId, { limit: 2 });
    expect(page1.neighbors.map((n) => n.externalId)).toEqual(["d1", "d2"]);
    expect(page1.hasMore).toBe(true);
    const staleCursor = page1.nextCursor!; // minted from d2's row

    // Delete the edge d2's row was built from — the cursor's values
    // (weight/nodeId/edgeId) now name a row that no longer exists.
    const d2EdgeId = page1.neighbors[1]!.edgeId;
    await db.delete(edges).where(inArray(edges.id, [d2EdgeId]));

    const page2 = await getNeighbors(db, hubId, { limit: 2, cursor: staleCursor });
    expect(page2.neighbors.map((n) => n.externalId)).toEqual(["d3", "d4"]);
    expect(page2.hasMore).toBe(false);
  });
});

// --- getNodesByExternalId: one test per "Nodes can be resolved by source identity" scenario ---

describe("getNodesByExternalId", () => {
  /** A database whose only behaviour is counting `execute` calls — for asserting a rejection happened before any SQL. */
  function spyDb(): { db: Database; executed: () => number } {
    let executed = 0;
    const db = {
      execute: async () => {
        executed += 1;
        return { rows: [] };
      },
    } as unknown as Database;
    return { db, executed: () => executed };
  }

  it("answers found and not-found pairs in one call with the canonical id and type; the pair, not the id alone, is the key (spec: Resolving a loader's cross-references)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "gh-issue", externalId: "owner/name#12", title: "Twelve", content: "" },
      { nodeType: "gh-pr", externalId: "owner/name#40", title: "Forty", content: "" },
    ]);
    const otherSource = `${run.sourceSystem}-other`;

    const result = await getNodesByExternalId(db, [
      { sourceSystem: run.sourceSystem, externalId: "owner/name#12" },
      { sourceSystem: run.sourceSystem, externalId: "owner/name#9999" },
      { sourceSystem: otherSource, externalId: "owner/name#12" },
      { sourceSystem: run.sourceSystem, externalId: "owner/name#40" },
    ]);

    expect(result.found).toEqual([
      { sourceSystem: run.sourceSystem, externalId: "owner/name#12", id: nodeMap.get("owner/name#12"), nodeType: "gh-issue" },
      { sourceSystem: run.sourceSystem, externalId: "owner/name#40", id: nodeMap.get("owner/name#40"), nodeType: "gh-pr" },
    ]);
    expect(result.notFound).toHaveLength(2);
    expect(result.notFound).toEqual(
      expect.arrayContaining([
        { sourceSystem: run.sourceSystem, externalId: "owner/name#9999" },
        { sourceSystem: otherSource, externalId: "owner/name#12" },
      ]),
    );
  });

  it("answers a pair naming a merged-away node with the survivor's id and the survivor's type (spec: A merged-away pair)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "" },
      { nodeType: "note", externalId: "loser", title: "Loser", content: "" },
    ]);
    await mergeNodes(db, nodeMap.get("loser")!, nodeMap.get("survivor")!, run);

    const result = await getNodesByExternalId(db, [{ sourceSystem: run.sourceSystem, externalId: "loser" }]);

    expect(result).toEqual({
      found: [{ sourceSystem: run.sourceSystem, externalId: "loser", id: nodeMap.get("survivor"), nodeType: "doc" }],
      notFound: [],
    });
  });

  it("gives the same answer whatever the order of the pairs (spec: nothing depends on the order)", async () => {
    const run = await newRun();
    await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "A", content: "" },
      { nodeType: "doc", externalId: "b", title: "B", content: "" },
    ]);
    const pairs: ExternalIdPair[] = ["a", "missing", "b"].map((externalId) => ({ sourceSystem: run.sourceSystem, externalId }));

    const forward = await getNodesByExternalId(db, pairs);
    const reversed = await getNodesByExternalId(db, [...pairs].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.found.map((f) => f.externalId)).toEqual(["a", "b"]);
    expect(forward.notFound.map((f) => f.externalId)).toEqual(["missing"]);
  });

  it("answers a duplicated pair once, trimmed, and an empty batch without a round trip", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "a", title: "A", content: "" }]);

    const result = await getNodesByExternalId(db, [
      { sourceSystem: run.sourceSystem, externalId: "a" },
      { sourceSystem: ` ${run.sourceSystem} `, externalId: " a " },
      { sourceSystem: run.sourceSystem, externalId: "zzz" },
      { sourceSystem: run.sourceSystem, externalId: "zzz" },
    ]);
    expect(result.found).toEqual([{ sourceSystem: run.sourceSystem, externalId: "a", id: nodeMap.get("a"), nodeType: "doc" }]);
    expect(result.notFound).toEqual([{ sourceSystem: run.sourceSystem, externalId: "zzz" }]);

    const spy = spyDb();
    expect(await getNodesByExternalId(spy.db, [])).toEqual({ found: [], notFound: [] });
    expect(spy.executed()).toBe(0);
  });

  it("rejects an empty source system or external id naming the pair's position, and more pairs than the bound, before any SQL runs (spec: Malformed pair)", async () => {
    const spy = spyDb();
    const ok: ExternalIdPair = { sourceSystem: "github", externalId: "owner/name#12" };

    await expect(getNodesByExternalId(spy.db, [{ sourceSystem: "", externalId: "x" }])).rejects.toThrow(
      'invalid external-id pair {"sourceSystem":"","externalId":"x"}: sourceSystem must be a non-empty string (pair at index 0)',
    );
    await expect(getNodesByExternalId(spy.db, [ok, { sourceSystem: "github", externalId: "   " }])).rejects.toThrow(/externalId must be a non-empty string \(pair at index 1\)/);
    await expect(getNodesByExternalId(spy.db, [ok, { sourceSystem: "github", externalId: undefined as unknown as string }])).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getNodesByExternalId(spy.db, [ok, null as unknown as ExternalIdPair])).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getNodesByExternalId(spy.db, "github" as unknown as ExternalIdPair[])).rejects.toBeInstanceOf(InvalidLookupIdError);

    const tooMany: ExternalIdPair[] = Array.from({ length: MAX_EXTERNAL_ID_LOOKUPS + 1 }, (_, i) => ({ sourceSystem: "github", externalId: `x${i}` }));
    let thrown: unknown;
    try {
      await getNodesByExternalId(spy.db, tooMany);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidLookupOptionError);
    expect((thrown as InvalidLookupOptionError).option).toBe("pairs");
    expect((thrown as InvalidLookupOptionError).value).toBe(MAX_EXTERNAL_ID_LOOKUPS + 1);
    expect(spy.executed()).toBe(0);

    // Exactly the bound is accepted: it reaches the database (whose empty
    // answer the read then reports as a failure, which is not the point).
    await expect(getNodesByExternalId(spy.db, tooMany.slice(0, MAX_EXTERNAL_ID_LOOKUPS))).rejects.toBeInstanceOf(LookupFailedError);
    expect(spy.executed()).toBe(1);
  });

  it("throws LookupFailedError, rather than dropping the pair, when its canonical id has no canonical row — a chain built past the trigger by raw SQL", async () => {
    // nodes_merged_into_canonical_trigger refuses a pointer AT a merged row;
    // it cannot see a survivor being merged away after a loser already
    // points at it — that repointing is mergeNodes' job. Raw SQL skips it.
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "A", content: "" },
      { nodeType: "doc", externalId: "b", title: "B", content: "" },
      { nodeType: "doc", externalId: "c", title: "C", content: "" },
    ]);
    await mergeNodes(db, nodeMap.get("a")!, nodeMap.get("b")!, run);
    await db.execute(sql`UPDATE nodes SET merged_into = ${nodeMap.get("c")!}::uuid WHERE id = ${nodeMap.get("b")!}::uuid`);

    let thrown: unknown;
    try {
      await getNodesByExternalId(db, [{ sourceSystem: run.sourceSystem, externalId: "a" }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LookupFailedError);
    expect((thrown as LookupFailedError).operation).toBe("getNodesByExternalId");
    expect((thrown as LookupFailedError).message).toContain(`(${run.sourceSystem}, a)`);
  });

  it("buildGetNodesByExternalIdQuery is pure, one statement, binds both halves of every pair, folds through nodes and reads the canonical row through resolved_nodes", () => {
    const dialect = new PgDialect();
    const pairs: ExternalIdPair[] = [
      { sourceSystem: "github", externalId: "owner/name#12" },
      { sourceSystem: "git", externalId: "owner/name@abc" },
    ];
    const a = dialect.sqlToQuery(buildGetNodesByExternalIdQuery(pairs));
    const b = dialect.sqlToQuery(buildGetNodesByExternalIdQuery(pairs));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
    expect(a.sql).not.toContain(";");
    expect(a.params).toEqual(["github", "git", "owner/name#12", "owner/name@abc"]);
    expect(a.sql).toContain("LEFT JOIN nodes n ON n.source_system = req.source_system AND n.external_id = req.external_id");
    expect(a.sql).toContain("LEFT JOIN resolved_nodes c ON c.id = r.canonical_id");
  });
});
