// End-to-end coverage of the seven brain_* tools, driven through the real
// MCP protocol (a Client talking to the Server built by createServer())
// rather than by calling tool handlers directly — this is what actually
// proves argument validation, tool advertisement, and error mapping work
// as a Claude session would see them. One test per brain-mcp spec
// scenario; see the ticket's requirements list for the mapping.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { EdgeInput, IngestRunHandle, NodeInput } from "@breakdown/core";
import { mergeNodes, openIngestRun, upsertEdges, upsertNodes } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { createServer, type CreateServerOptions } from "./server.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
// Rows created directly through @breakdown/core helpers (setup fixtures),
// scoped by a unique source_system per test run.
const usedSourceSystems: string[] = [];
// ingest_runs rows to delete at the end (both the helper-opened ones above
// and every run a brain_write/brain_link tool call opens).
const openRunIds: string[] = [];
// nodes/edges created THROUGH the MCP tools (brain_write/brain_link),
// which default sourceSystem to "agent" — cleaned up by ingest_run_id
// instead, since "agent" is not a fixture-unique value we can bulk-delete.
const toolRunIds: string[] = [];

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterEach(async () => {
  if (toolRunIds.length > 0) {
    await db.delete(edges).where(inArray(edges.ingestRunId, toolRunIds));
    await db.delete(nodes).where(inArray(nodes.ingestRunId, toolRunIds));
    openRunIds.push(...toolRunIds);
    toolRunIds.length = 0;
  }
  if (usedSourceSystems.length > 0) {
    await db.delete(edges).where(inArray(edges.sourceSystem, usedSourceSystems));
    await db.delete(nodes).where(inArray(nodes.sourceSystem, usedSourceSystems));
    usedSourceSystems.length = 0;
  }
  if (openRunIds.length > 0) {
    await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRunIds));
    openRunIds.length = 0;
  }
  // A brain_write/brain_link call that fails validation (e.g.
  // ContentTooLargeError) still opens and closes an ingest run via
  // withAgentIngestRun (attribution.ts) before the error surfaces — its id
  // never reaches the tool's JSON result, so it can't be pushed into
  // toolRunIds like a successful call's can. Any such run is
  // unambiguously an orphan: a real write always leaves node_count>0 or
  // edge_count>0, so "agent" + both zero can only be a run that opened
  // and immediately failed. Swept up after every test rather than
  // per-test, since which test id produced it isn't otherwise knowable.
  await db.delete(ingestRuns).where(and(eq(ingestRuns.sourceSystem, "agent"), eq(ingestRuns.nodeCount, 0), eq(ingestRuns.edgeCount, 0)));
});

afterAll(async () => {
  await pool.end();
});

function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, "");
}

async function newRun(): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, `mcp-test-${uniqueSuffix()}`);
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


async function connectClient(opts?: CreateServerOptions): Promise<{ client: Client }> {
  const server = createServer(db, opts);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstText(raw: any): string {
  const first = raw.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected text content, got ${JSON.stringify(raw.content)}`);
  }
  return first.text as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseText(raw: any): any {
  return JSON.parse(firstText(raw));
}

const BOGUS_ID = "00000000-0000-0000-0000-000000000000";

// --- Tool listing (spec: "No arbitrary SQL from the model", "Read-only mode") ---

describe("tool listing", () => {
  it("advertises all seven tools with object-shaped input schemas, and no SQL passthrough tool", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["brain_get", "brain_link", "brain_map", "brain_merge", "brain_neighbors", "brain_search", "brain_write"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

// --- brain_search (spec: "Agent searches for context") -----------------------

describe("brain_search", () => {
  it("states the bounds it used when called with only a query", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Echo defaults probe", content: "echo defaults probe unique phrase alpha" }]);
    const { client } = await connectClient();

    const raw = await client.callTool({ name: "brain_search", arguments: { query: "echo defaults probe alpha", sourceSystems: [run.sourceSystem] } });
    const result = parseText(raw);

    expect(result.defaultsUsed).toEqual({ seedLimit: 10, minRelevance: 1e-6, maxDepth: 2, fanout: 25, nodeBudget: 40, decay: 0.6 });
    expect(result.mode).toBe("exact");
    expect(result.nodes.some((n: { externalId: string }) => n.externalId === "n1")).toBe(true);
  });

  it("honors an explicit override and still echoes it back in defaultsUsed", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_search", arguments: { query: "anything", maxDepth: 1 } });
    const result = parseText(raw);
    expect(result.defaultsUsed.maxDepth).toBe(1);
  });
});

// --- brain_get (spec: "fetches one or more nodes by identifier") -------------

describe("brain_get", () => {
  it("returns full content, resolves a merged-away id to its survivor, and reports notFoundIds", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "survivor content" },
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "loser content" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    await mergeNodes(db, loserId, survivorId, run);

    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_get", arguments: { ids: [loserId, BOGUS_ID] } });
    const result = parseText(raw);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe(survivorId);
    expect(result.nodes[0].content).toBe("survivor content");
    expect(result.notFoundIds).toEqual([BOGUS_ID]);
  });

  it("maps an invalid id to a message naming it, not a generic failure", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_get", arguments: { ids: ["not-a-uuid"] } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/not-a-uuid/);
  });

  it("rejects a batch larger than the 1000-id ceiling before it ever reaches the database", async () => {
    const { client } = await connectClient();
    const ids = Array.from({ length: 1001 }, () => BOGUS_ID);
    const raw = await client.callTool({ name: "brain_get", arguments: { ids } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/1000/);
  });
});

// --- brain_neighbors (spec: "Agent follows an edge") --------------------------

describe("brain_neighbors", () => {
  it("returns adjacent nodes with edge type, direction, weight, and source system", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "center", title: "Center", content: "c" },
      { nodeType: "doc", externalId: "nbr", title: "Neighbor", content: "c" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("center")!, dstId: nodeMap.get("nbr")!, edgeType: "mentions", weight: 0.8 }]);

    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_neighbors", arguments: { id: nodeMap.get("center")! } });
    const result = parseText(raw);

    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]).toMatchObject({
      direction: "outgoing",
      edgeType: "mentions",
      nodeId: nodeMap.get("nbr"),
      nodeSourceSystem: run.sourceSystem,
      edgeSourceSystem: run.sourceSystem,
    });
  });

  it("excludes a merge-induced self-loop and resolves a merged-away queried id to its survivor", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "loser", title: "Loser", content: "c" },
      { nodeType: "doc", externalId: "survivor", title: "Survivor", content: "c" },
    ]);
    const loserId = nodeMap.get("loser")!;
    const survivorId = nodeMap.get("survivor")!;
    await makeEdges(run, [{ srcId: loserId, dstId: survivorId, edgeType: "mentions", weight: 0.9 }]);
    await mergeNodes(db, loserId, survivorId, run);

    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_neighbors", arguments: { id: loserId } });
    const result = parseText(raw);

    expect(result.canonicalId).toBe(survivorId);
    expect(result.resolvedFromMerge).toBe(true);
    expect(result.neighbors).toEqual([]);
  });

  it("maps a nonexistent id to an actionable NodeNotFoundError message", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_neighbors", arguments: { id: BOGUS_ID } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/does not exist/i);
  });
});

// --- brain_map (spec: "Agent orients in an unfamiliar store") -----------------

describe("brain_map", () => {
  it("reports node/source/edge type counts, recent nodes, and echoes defaults", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "T1", content: "c" },
      { nodeType: "spec", externalId: "n2", title: "T2", content: "c" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "relates_to", weight: 0.5 }]);

    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_map", arguments: {} });
    const result = parseText(raw);

    expect(result.defaultsUsed).toEqual({ recentNodesLimit: 10 });
    const sourceEntry = result.sourceSystems.find((s: { sourceSystem: string }) => s.sourceSystem === run.sourceSystem);
    expect(sourceEntry?.count).toBe(2);
    const edgeEntry = result.edgeTypes.find((e: { edgeType: string }) => e.edgeType === "relates_to");
    expect(edgeEntry).toBeDefined();
  });
});

// --- brain_write (spec: "Batch write and link tools") -------------------------

describe("brain_write", () => {
  it("accepts a batch in one call, shares one ingest run, and reports created/updated/unchanged (spec: bulk load, re-load)", async () => {
    const suffix = uniqueSuffix();
    const sourceSystem = `mcp-write-${suffix}`;
    const { client } = await connectClient();

    const items = [
      { nodeType: "doc", externalId: `a-${suffix}`, sourceSystem, title: "A", content: "content a" },
      { nodeType: "doc", externalId: `b-${suffix}`, sourceSystem, title: "B", content: "content b" },
    ];

    const first = parseText(await client.callTool({ name: "brain_write", arguments: { items } }));
    toolRunIds.push(first.ingestRunId);
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);
    expect(first.items.every((i: { action: string }) => i.action === "created")).toBe(true);

    const second = parseText(await client.callTool({ name: "brain_write", arguments: { items } }));
    toolRunIds.push(second.ingestRunId);
    expect(second.ingestRunId).not.toBe(first.ingestRunId);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it("accepts a single item, not wrapped in an array", async () => {
    const suffix = uniqueSuffix();
    const { client } = await connectClient();
    const result = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `single-${suffix}`, sourceSystem: `mcp-write-single-${suffix}`, content: "c" } },
      }),
    );
    toolRunIds.push(result.ingestRunId);
    expect(result.created).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it("defaults sourceSystem to \"agent\" when omitted", async () => {
    const suffix = uniqueSuffix();
    const { client } = await connectClient();
    const result = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `agent-default-${suffix}`, title: "Agent default", content: "c" } },
      }),
    );
    toolRunIds.push(result.ingestRunId);
    expect(result.items[0].sourceSystem).toBe("agent");
  });

  it("stores SQL-looking content as literal text and never executes it (spec: no arbitrary SQL from the model)", async () => {
    const suffix = uniqueSuffix();
    const sourceSystem = `mcp-sql-${suffix}`;
    const { client } = await connectClient();
    const maliciousTitle = "Robert'); DROP TABLE nodes;--";
    const maliciousContent = "1'; DELETE FROM nodes WHERE '1'='1'; SELECT * FROM ingest_runs;--";

    const writeResult = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `sql-${suffix}`, sourceSystem, title: maliciousTitle, content: maliciousContent } },
      }),
    );
    toolRunIds.push(writeResult.ingestRunId);
    const nodeId = writeResult.items[0].id;

    const getResult = parseText(await client.callTool({ name: "brain_get", arguments: { ids: [nodeId] } }));
    expect(getResult.nodes[0].title).toBe(maliciousTitle);
    expect(getResult.nodes[0].content).toBe(maliciousContent);

    // The store must still be intact and functional afterward — proof the
    // string was stored as literal text and never executed as SQL.
    const mapResult = parseText(await client.callTool({ name: "brain_map", arguments: {} }));
    expect(mapResult.totalNodes).toBeGreaterThan(0);
    const searchResult = parseText(await client.callTool({ name: "brain_search", arguments: { query: "Robert", sourceSystems: [sourceSystem] } }));
    expect(["exact", "fuzzy", "empty"]).toContain(searchResult.mode);
  });

  it("maps ContentTooLargeError to a message naming the batch index and the max length", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({
      name: "brain_write",
      arguments: { items: { nodeType: "doc", externalId: `too-large-${uniqueSuffix()}`, content: "x".repeat(1_000_001) } },
    });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/batch index 0/);
    expect(firstText(raw)).toMatch(/1000000/);
    // withAgentIngestRun (attribution.ts) opens the run before upsertNodes
    // validates content length, and always closes it in a `finally` even
    // on failure, leaving an empty "agent" run with no ingestRunId
    // reaching this test to track — swept up by afterEach's orphan sweep.
  });

  it("maps invalid arguments (empty batch) to a message naming the field, with no raw stack trace", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_write", arguments: { items: [] } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/items/);
    expect(firstText(raw)).not.toMatch(/\s+at\s+\S+\s+\(/);
  });

  it("rejects a batch larger than the 1000-item ceiling before it ever reaches the database (bd-vt2.5 review: an unbounded 30,000-item batch previously succeeded)", async () => {
    const { client } = await connectClient();
    const suffix = uniqueSuffix();
    const items = Array.from({ length: 1001 }, (_, i) => ({ nodeType: "doc", externalId: `batch-cap-${i}-${suffix}` }));
    const raw = await client.callTool({ name: "brain_write", arguments: { items } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/1000/);
  });
});

// --- brain_link (spec: "Agent links two existing nodes") ----------------------

describe("brain_link", () => {
  it("accepts a batch, shares one ingest run, and defaults weight to 1.0 and sourceSystem to \"agent\"", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "A", content: "c" },
      { nodeType: "doc", externalId: "b", title: "B", content: "c" },
    ]);
    const { client } = await connectClient();

    const result = parseText(
      await client.callTool({
        name: "brain_link",
        arguments: { items: { srcId: nodeMap.get("a")!, dstId: nodeMap.get("b")!, edgeType: "mentions" } },
      }),
    );
    toolRunIds.push(result.ingestRunId);
    expect(result.created).toBe(1);
    expect(result.items[0].sourceSystem).toBe("agent");

    const neighbors = parseText(await client.callTool({ name: "brain_neighbors", arguments: { id: nodeMap.get("a")! } }));
    expect(neighbors.neighbors[0].weight).toBeCloseTo(1.0);
  });

  it("rejects an out-of-range weight at the argument schema itself, naming the field (InvalidEdgeWeightError's core-level mapping is covered directly in errors.test.ts, since the MCP schema mirrors core's [0,1] bound as defense in depth)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "A", content: "c" },
      { nodeType: "doc", externalId: "b", title: "B", content: "c" },
    ]);
    const { client } = await connectClient();
    const raw = await client.callTool({
      name: "brain_link",
      arguments: { items: { srcId: nodeMap.get("a")!, dstId: nodeMap.get("b")!, edgeType: "mentions", weight: 1.4 } },
    });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/weight/);
  });

  it("rejects a batch larger than the 1000-item ceiling before it ever reaches the database", async () => {
    const { client } = await connectClient();
    const bogusId = "00000000-0000-0000-0000-000000000000";
    const items = Array.from({ length: 1001 }, (_, i) => ({ srcId: bogusId, dstId: bogusId, edgeType: `e${i}` }));
    const raw = await client.callTool({ name: "brain_link", arguments: { items } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/1000/);
  });
});

// --- brain_merge (spec: "Merge tool for duplicates the agent notices") --------

describe("brain_merge", () => {
  it("merges a duplicate into a survivor and is idempotent on re-application (spec: merge targets the same node twice)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "Merge probe alpha", content: "merge probe unique phrase omega" },
      { nodeType: "doc", externalId: "b", title: "Merge probe beta", content: "merge probe unique phrase omega" },
    ]);
    const { client } = await connectClient();

    const first = parseText(await client.callTool({ name: "brain_merge", arguments: { loserId: nodeMap.get("b")!, survivorId: nodeMap.get("a")! } }));
    // The merge is attributed to an agent run whose id comes back. That
    // run has node_count 1 (the loser is stamped with it), so afterEach's
    // orphan sweep will not catch it — track it for cleanup explicitly.
    expect(typeof first.ingestRunId).toBe("string");
    openRunIds.push(first.ingestRunId);
    expect(first.survivorId).toBe(nodeMap.get("a"));
    expect(first.noOp).toBe(false);
    expect(first.mergedNodeIds).toEqual([nodeMap.get("b")]);

    const second = parseText(await client.callTool({ name: "brain_merge", arguments: { loserId: nodeMap.get("b")!, survivorId: nodeMap.get("a")! } }));
    expect(second.survivorId).toBe(nodeMap.get("a"));
    expect(second.noOp).toBe(true);
    expect(second.mergedNodeIds).toEqual([]);

    // Spec: "subsequent searches return only the survivor."
    const afterMerge = parseText(await client.callTool({ name: "brain_search", arguments: { query: "merge probe omega", sourceSystems: [run.sourceSystem] } }));
    expect(afterMerge.mode).not.toBe("empty");
    expect(afterMerge.nodes.some((n: { id: string }) => n.id === nodeMap.get("a"))).toBe(true);
    expect(afterMerge.nodes.some((n: { id: string }) => n.id === nodeMap.get("b"))).toBe(false);
  });

  it("maps SelfMergeError to an actionable message", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "a", title: "A", content: "c" }]);
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_merge", arguments: { loserId: nodeMap.get("a")!, survivorId: nodeMap.get("a")! } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/itself/i);
  });
});

// --- Read-only mode (spec: "Read-only mode") -----------------------------------

describe("read-only mode", () => {
  it("does not advertise brain_write/brain_link/brain_merge", async () => {
    const { client } = await connectClient({ readOnly: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["brain_get", "brain_map", "brain_neighbors", "brain_search"]);
  });

  it("refuses brain_write with an explanatory error and persists nothing", async () => {
    const { client } = await connectClient({ readOnly: true });
    const suffix = uniqueSuffix();
    const externalId = `ro-${suffix}`;
    const raw = await client.callTool({
      name: "brain_write",
      arguments: { items: { nodeType: "doc", externalId, sourceSystem: `mcp-ro-${suffix}`, content: "should not persist" } },
    });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/read-only/i);

    const search = parseText(await client.callTool({ name: "brain_search", arguments: { query: externalId } }));
    if (search.mode !== "empty") {
      expect(search.nodes.every((n: { externalId: string }) => n.externalId !== externalId)).toBe(true);
    }
  });

  it("refuses brain_link and brain_merge, called anyway, each with a read-only explanation", async () => {
    const { client } = await connectClient({ readOnly: true });

    const linkRaw = await client.callTool({
      name: "brain_link",
      arguments: { items: { srcId: BOGUS_ID, dstId: BOGUS_ID.replace(/0$/, "1"), edgeType: "e" } },
    });
    expect(linkRaw.isError).toBe(true);
    expect(firstText(linkRaw)).toMatch(/read-only/i);

    const mergeRaw = await client.callTool({ name: "brain_merge", arguments: { loserId: BOGUS_ID, survivorId: BOGUS_ID.replace(/0$/, "1") } });
    expect(mergeRaw.isError).toBe(true);
    expect(firstText(mergeRaw)).toMatch(/read-only/i);
  });
});

// --- Bounded responses (spec: "Bounded responses") ----------------------------

describe("bounded responses", () => {
  it("truncates an oversized brain_search response, states so, and returns fetchable dropped node ids", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [];
    for (let i = 0; i < 8; i++) {
      specs.push({ nodeType: "doc", externalId: `budget-${i}`, title: `Budget probe ${i}`, content: `budget probe unique phrase zzzeta ${"x".repeat(500)}` });
    }
    await makeNodes(run, specs);

    const { client } = await connectClient({ responseCharBudget: 1500 });
    const raw = await client.callTool({
      name: "brain_search",
      arguments: { query: "budget probe zzzeta", sourceSystems: [run.sourceSystem], nodeBudget: 8 },
    });
    const result = parseText(raw);

    expect(result.truncated).toBe(true);
    expect(result.droppedNodeIds.length).toBeGreaterThan(0);
    // Not a bare "truncated: true" — there must be actionable guidance and
    // a concrete means to get the rest.
    expect(typeof result.truncationNote).toBe("string");
    expect(result.truncationNote.length).toBeGreaterThan(20);

    const fetched = parseText(await client.callTool({ name: "brain_get", arguments: { ids: [result.droppedNodeIds[0]] } }));
    expect(fetched.nodes).toHaveLength(1);
  });

  it("truncates an oversized brain_get response the same way", async () => {
    const run = await newRun();
    // Content sized to individually fit under the budget below (so this
    // exercises plain "keep one, drop the other" truncation) — the
    // dedicated shrink-in-place path (a single item bigger than the
    // whole budget on its own) is covered separately below.
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "big1", content: "x".repeat(2000) },
      { nodeType: "doc", externalId: "big2", content: "y".repeat(2000) },
    ]);
    const bigIds = [nodeMap.get("big1")!, nodeMap.get("big2")!];
    const { client } = await connectClient({ responseCharBudget: 3000 });
    const raw = await client.callTool({ name: "brain_get", arguments: { ids: bigIds } });
    const result = parseText(raw);

    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(1);
    expect(result.droppedNodeIds).toHaveLength(1);
    expect(result.shrunkNodeIds).toEqual([]);
    // brain_get has no relevance score to rank by, so getNodes() returns a
    // deterministic id order rather than a meaningful "best first" one —
    // only assert the two requested ids partition into kept/dropped, not
    // which specific one lands where.
    const allIds = [...result.nodes.map((n: { id: string }) => n.id), ...result.droppedNodeIds];
    expect(new Set(allIds)).toEqual(new Set(bigIds));
  });

  it("rejects a brain_write item with pathologically large metadata at the argument schema, before it ever reaches core (bd-vt2.5 MUST-FIX review)", async () => {
    const { client } = await connectClient();
    const suffix = uniqueSuffix();
    const raw = await client.callTool({
      name: "brain_write",
      arguments: {
        items: {
          nodeType: "doc",
          externalId: `landmine-${suffix}`,
          sourceSystem: `mcp-landmine-${suffix}`,
          // 5MB, matching the review's reproduction exactly.
          metadata: { blob: "m".repeat(5_000_000) },
        },
      },
    });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/metadata/i);
    expect(firstText(raw)).toMatch(/characters/i);
  });

  it("a node with oversized metadata that bypasses the write-time cap (a landmine written before this fix, or by a future direct-core caller) is defused by brain_get's response shrinking, not returned whole", async () => {
    // Simulates exactly what the review measured: writes directly through
    // core with the cap explicitly raised (standing in for a pre-existing
    // row, or any writer other than this MCP server's own schema), then
    // proves the READ side is the actual backstop — brain_get must still
    // keep the response bounded even though nothing at write time caught
    // this particular row.
    const run = await newRun();
    const hugeMetadata = { blob: "m".repeat(5_000_000) };
    const writeResult = await upsertNodes(
      db,
      run,
      [{ nodeType: "doc", sourceSystem: run.sourceSystem, externalId: "landmine-bypass", title: "Landmine", content: "short content", metadata: hugeMetadata }],
      { maxMetadataLength: Number.MAX_SAFE_INTEGER },
    );
    const landmineId = writeResult.rows[0]!.id;

    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_get", arguments: { ids: [landmineId] } });

    // Measured against the exact wire bytes, the same way the server
    // itself will send it.
    const wireBytes = JSON.stringify(raw).length;
    expect(wireBytes).toBeLessThan(200_000); // nowhere near the ~5,000,545 chars this landmine used to produce
    const result = parseText(raw);
    expect(result.shrunkNodeIds).toEqual([landmineId]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe(landmineId);
    expect(result.nodes[0].title).toBe("Landmine"); // small fields survive untouched
    expect(typeof result.nodes[0].metadata).toBe("string"); // the oversized field, replaced with a placeholder
    expect(result.nodes[0].metadata).toContain("omitted");
  });
});

// --- Error mapping / protocol basics -------------------------------------------

describe("error handling", () => {
  it("rejects an unknown tool name at the protocol level", async () => {
    const { client } = await connectClient();
    await expect(client.callTool({ name: "brain_delete_everything", arguments: {} })).rejects.toThrow();
  });

  it("maps invalid arguments to a message naming the offending field, never a raw stack trace", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_search", arguments: { query: "" } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/query/);
    expect(firstText(raw)).not.toMatch(/\s+at\s+\S+\s+\(/);
  });

  it("rejects an out-of-range maxDepth at the argument schema itself, naming the field (the MCP schema mirrors core's bounds as defense in depth)", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_search", arguments: { query: "anything", maxDepth: 99 } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/maxDepth/);
  });

  it("maps EmptyQueryError (stopwords only) to an actionable message with no stack trace", async () => {
    const { client } = await connectClient();
    const raw = await client.callTool({ name: "brain_search", arguments: { query: "the of and" } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).not.toMatch(/\s+at\s+\S+\s+\(/);
  });
});
