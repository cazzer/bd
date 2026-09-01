import { PgDialect } from "drizzle-orm/pg-core";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, NodeNotFoundError } from "./errors.js";
import type { EdgeInput } from "./edges.js";
import { upsertEdges } from "./edges.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import type { NodeInput } from "./nodes.js";
import { upsertNodes } from "./nodes.js";
import { buildGetNeighborsQuery, buildGetNodesQuery, DEFAULT_NEIGHBOR_LIMIT, getNeighbors, getNodes, type NeighborsCursor } from "./lookup.js";
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

    const withCursor = { id: BOGUS_ID, limit: 10, cursor: { weight: 0.5, nodeId: BOGUS_ID, edgeId: BOGUS_ID } };
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
    await mergeNodes(db, loserId, survivorId);

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
    await mergeNodes(db, loserId, survivorId);

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
    await mergeNodes(db, loserId, survivorId);

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
    await mergeNodes(db, loserId, survivorId);

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
    await mergeNodes(db, loserId, survivorId);

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
    await mergeNodes(db, nbrLoserId, nbrSurvivorId);

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
    await expect(getNeighbors(db, id, { cursor: { weight: 0.5, nodeId: "not-a-uuid", edgeId: BOGUS_ID } })).rejects.toBeInstanceOf(
      InvalidLookupOptionError,
    );
    await expect(getNeighbors(db, id, { cursor: { weight: Number.NaN, nodeId: BOGUS_ID, edgeId: BOGUS_ID } })).rejects.toBeInstanceOf(
      InvalidLookupOptionError,
    );
  });
});
