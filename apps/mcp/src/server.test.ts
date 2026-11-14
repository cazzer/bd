// End-to-end coverage of the brain_* tools (the hangar tools are in
// hangar-tools.test.ts), driven through the real
// MCP protocol (a Client talking to the Server built by createServer())
// rather than by calling tool handlers directly — this is what actually
// proves argument validation, tool advertisement, and error mapping work
// as a Claude session would see them. One test per brain-mcp spec
// scenario; see the ticket's requirements list for the mapping.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { EdgeInput, IngestRunHandle, NodeInput } from "@breakdown/core";
import { closeIngestRun, mergeNodes, openIngestRun, resolveDefaultViews, upsertEdges, upsertNodes } from "@breakdown/core";
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
// Every actor a client in this file records ("name version" of its
// clientInfo): connectClient's default and the claude-code identity the
// attribution tests pass. Versions carry a per-file suffix so no other
// test file's client (or a live session) can ever share one of these actors.
const FILE_SUFFIX = randomUUID().replace(/-/g, "");
const DEFAULT_CLIENT = { name: "test-client", version: `0.0.0+${FILE_SUFFIX}` };
const CLAUDE_CODE_CLIENT = { name: "claude-code", version: `2.1.0+${FILE_SUFFIX}` };
const CLAUDE_CODE_ACTOR = `${CLAUDE_CODE_CLIENT.name} ${CLAUDE_CODE_CLIENT.version}`;
const TEST_CLIENT_ACTORS = [`${DEFAULT_CLIENT.name} ${DEFAULT_CLIENT.version}`, CLAUDE_CODE_ACTOR];

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
  // Scoped to the actors this file's clients introduce themselves as: an
  // in-flight run also has both counts zero until it closes, and an
  // unscoped sweep deletes one belonging to stdio.test.ts (running in
  // parallel) or to a live session sharing the database. Only finished
  // runs (finished_at set) are swept, so even an actor collision can never
  // delete a run whose write is still in flight.
  await db
    .delete(ingestRuns)
    .where(and(eq(ingestRuns.sourceSystem, "agent"), inArray(ingestRuns.actor, TEST_CLIENT_ACTORS), eq(ingestRuns.nodeCount, 0), eq(ingestRuns.edgeCount, 0), isNotNull(ingestRuns.finishedAt)));
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


/** `clientInfo` is what the client sends in its initialize handshake — the server derives the actor it records on ingest runs from it. */
async function connectClient(opts?: CreateServerOptions, clientInfo: { name: string; version: string } = DEFAULT_CLIENT): Promise<{ client: Client }> {
  const server = createServer(db, opts);
  const client = new Client(clientInfo);
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
  it("advertises all fourteen tools with object-shaped input schemas, and no SQL passthrough tool", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "brain_get",
      "brain_hangar_request",
      "brain_hangar_sessions",
      "brain_hangar_status",
      "brain_history",
      "brain_link",
      "brain_list",
      "brain_map",
      "brain_merge",
      "brain_neighbors",
      "brain_ready",
      "brain_search",
      "brain_update_work_item",
      "brain_write",
    ]);
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

  it("records the connected client, as it introduced itself, as the actor on its ingest run — with no environment variable or argument involved (spec: writes name the connected client)", async () => {
    const suffix = uniqueSuffix();
    const { client } = await connectClient(undefined, CLAUDE_CODE_CLIENT);
    const result = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `actor-${suffix}`, sourceSystem: `mcp-actor-${suffix}`, content: "c" } },
      }),
    );
    toolRunIds.push(result.ingestRunId);

    const [run] = await db.select({ sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, result.ingestRunId));
    expect(run).toEqual({ sourceSystem: "agent", actor: CLAUDE_CODE_ACTOR });
  });

  it("prefixes the actor with the token client bound to the session (\"<client> via <name> <version>\")", async () => {
    const suffix = uniqueSuffix();
    const { client } = await connectClient({ tokenClient: "worker-1" }, CLAUDE_CODE_CLIENT);
    const result = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `token-actor-${suffix}`, sourceSystem: `mcp-actor-${suffix}`, content: "c" } },
      }),
    );
    toolRunIds.push(result.ingestRunId);

    const [run] = await db.select({ sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, result.ingestRunId));
    expect(run).toEqual({ sourceSystem: "agent", actor: `worker-1 via ${CLAUDE_CODE_ACTOR}` });
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

// --- brain_history (spec: "History tool") --------------------------------------

describe("brain_history", () => {
  /**
   * A node written and then re-written by two runs with source system
   * "human" — the shape the web app produces — under a fixture-unique node
   * source system so cleanup stays scoped. Each run is closed right after
   * its write so it never lingers as an empty human run.
   */
  async function writeUnderHumanRuns(sourceSystem: string, versions: readonly Omit<NodeInput, "sourceSystem">[]): Promise<{ id: string; runIds: string[] }> {
    usedSourceSystems.push(sourceSystem);
    let id = "";
    const runIds: string[] = [];
    for (const version of versions) {
      const run = await openIngestRun(db, "human", { actor: "human" });
      openRunIds.push(run.id);
      runIds.push(run.id);
      const result = await upsertNodes(db, run, [{ ...version, sourceSystem }]);
      await closeIngestRun(db, run);
      id = result.rows[0]!.id;
    }
    return { id, runIds };
  }

  it("reports a status flip with its before/after values, attributed to a run with source system human (spec: agent asks how a work item changed)", async () => {
    const { id, runIds } = await writeUnderHumanRuns(`mcp-history-${uniqueSuffix()}`, [
      { nodeType: "work_item", externalId: "wi", title: "Fix login", content: "body", metadata: { status: "open" } },
      { nodeType: "work_item", externalId: "wi", title: "Fix login", content: "body", metadata: { status: "closed" } },
    ]);
    const { client } = await connectClient();

    const result = parseText(await client.callTool({ name: "brain_history", arguments: { id } }));
    expect(result.id).toBe(id);
    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[0]).toMatchObject({
      revisionNo: 2,
      changedFields: ["metadata"],
      metadataChanges: { status: { before: "open", after: "closed" } },
      ingestRun: { id: runIds[1], sourceSystem: "human", actor: "human" },
    });
    expect(result.revisions[0].content).toBeUndefined();
    expect(typeof result.revisions[0].contentHash).toBe("string");
    expect(typeof result.revisions[0].recordedAt).toBe("string");
    expect(result.revisions[1]).toMatchObject({ revisionNo: 1, ingestRun: { id: runIds[0] } });
    expect(result.hasMore).toBe(false);
    expect(result.nextBefore).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.truncationNote).toBeUndefined();

    const withContent = parseText(await client.callTool({ name: "brain_history", arguments: { id, includeContent: true } }));
    expect(withContent.revisions[0].content).toBe("body");
  });

  it("is advertised and succeeds when the server is read-only (spec: history in read-only mode)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "ro", title: "RO", content: "c" }]);
    const { client } = await connectClient({ readOnly: true });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("brain_history");

    const raw = await client.callTool({ name: "brain_history", arguments: { id: nodeMap.get("ro")! } });
    expect(raw.isError).toBeFalsy();
    const result = parseText(raw);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0].ingestRun.id).toBe(run.id);
  });

  it("bounds a long history: over the requested limit it reports hasMore, nextBefore, and a note naming before=; over the response budget it drops the oldest revisions with the same note (spec: long history is bounded)", async () => {
    const run = await newRun();
    let id = "";
    for (let i = 1; i <= 4; i += 1) {
      const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "long", title: "Long", content: `v${i}` }]);
      id = nodeMap.get("long")!;
    }

    const { client } = await connectClient();
    const page1 = parseText(await client.callTool({ name: "brain_history", arguments: { id, limit: 2 } }));
    expect(page1.revisions.map((r: { revisionNo: number }) => r.revisionNo)).toEqual([4, 3]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBefore).toBe(3);
    expect(page1.truncated).toBe(true);
    expect(page1.truncationNote).toMatch(/before=3/);
    expect(page1.droppedRevisionNos).toEqual([]);

    const page2 = parseText(await client.callTool({ name: "brain_history", arguments: { id, limit: 2, before: page1.nextBefore } }));
    expect(page2.revisions.map((r: { revisionNo: number }) => r.revisionNo)).toEqual([2, 1]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBefore).toBeNull();
    expect(page2.truncated).toBe(false);
    expect(page2.truncationNote).toBeUndefined();

    // Response-size budget: three ~2k-char contents cannot fit in 3000
    // chars, so boundResponse drops from the tail — the OLDEST revisions
    // — and the cursor must account for that, not for what core returned.
    const bigRun = await newRun();
    let bigId = "";
    for (const fill of ["a", "b", "c"]) {
      const nodeMap = await makeNodes(bigRun, [{ nodeType: "doc", externalId: "big", title: "Big", content: fill.repeat(2000) }]);
      bigId = nodeMap.get("big")!;
    }
    const { client: smallClient } = await connectClient({ responseCharBudget: 3000 });
    const bounded = parseText(await smallClient.callTool({ name: "brain_history", arguments: { id: bigId, includeContent: true } }));
    expect(bounded.truncated).toBe(true);
    expect(bounded.droppedRevisionNos.length).toBeGreaterThan(0);
    expect(bounded.revisions.length + bounded.droppedRevisionNos.length).toBe(3);
    expect(bounded.revisions[0].revisionNo).toBe(3);
    const oldestKept = bounded.revisions[bounded.revisions.length - 1].revisionNo;
    expect(bounded.hasMore).toBe(true);
    expect(bounded.nextBefore).toBe(oldestKept);
    expect(bounded.truncationNote).toMatch(new RegExp(`before=${oldestKept}`));
    expect(bounded.truncationNote).toMatch(/dropped/);
    // Following the cursor reaches exactly the dropped revisions.
    const rest = parseText(await smallClient.callTool({ name: "brain_history", arguments: { id: bigId, before: bounded.nextBefore } }));
    expect(rest.revisions.map((r: { revisionNo: number }) => r.revisionNo)).toEqual(bounded.droppedRevisionNos);
  });

  it("shows a brain_merge in the loser's history, attributed to source system agent and this client's actor (spec: a merge shows up in history)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "a", title: "A", content: "c" },
      { nodeType: "doc", externalId: "b", title: "B", content: "c" },
    ]);
    const survivorId = nodeMap.get("a")!;
    const loserId = nodeMap.get("b")!;
    const { client } = await connectClient(undefined, CLAUDE_CODE_CLIENT);

    const merge = parseText(await client.callTool({ name: "brain_merge", arguments: { loserId, survivorId } }));
    openRunIds.push(merge.ingestRunId);

    const history = parseText(await client.callTool({ name: "brain_history", arguments: { id: loserId } }));
    expect(history.id).toBe(loserId);
    expect(history.revisions).toHaveLength(2);
    expect(history.revisions[0]).toMatchObject({
      revisionNo: 2,
      changedFields: ["mergedInto"],
      mergedInto: survivorId,
      title: "B",
      ingestRun: { id: merge.ingestRunId, sourceSystem: "agent", actor: CLAUDE_CODE_ACTOR },
    });
  });

  it("maps an unknown id, and a before cursor past int4 that only core can catch, to actionable errors", async () => {
    const { client } = await connectClient();

    const unknown = await client.callTool({ name: "brain_history", arguments: { id: BOGUS_ID } });
    expect(unknown.isError).toBe(true);
    expect(firstText(unknown)).toMatch(/does not exist/i);

    const malformed = await client.callTool({ name: "brain_history", arguments: { id: "not-a-uuid" } });
    expect(malformed.isError).toBe(true);
    expect(firstText(malformed)).toMatch(/not-a-uuid/);

    const run = await newRun();
    const nodeMap = await makeNodes(run, [{ nodeType: "doc", externalId: "opt", title: "O", content: "c" }]);
    const badBefore = await client.callTool({ name: "brain_history", arguments: { id: nodeMap.get("opt")!, before: 2147483648 } });
    expect(badBefore.isError).toBe(true);
    expect(firstText(badBefore)).toMatch(/before/);
    expect(firstText(badBefore)).toMatch(/adjust/i);
  });
});

// --- Read-only mode (spec: "Read-only mode") -----------------------------------

describe("read-only mode", () => {
  it("does not advertise brain_write/brain_link/brain_merge/brain_update_work_item/brain_hangar_request", async () => {
    const { client } = await connectClient({ readOnly: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["brain_get", "brain_hangar_sessions", "brain_hangar_status", "brain_history", "brain_list", "brain_map", "brain_neighbors", "brain_ready", "brain_search"]);
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


describe("brain_list", () => {
  it("lists work items by type and a status predicate, newest first, and pages with the cursor (spec: agent lists open work items)", async () => {
    const run = await newRun();
    // Written one at a time so updated_at strictly increases.
    const ids = new Map<string, string>();
    for (const [externalId, status, priority] of [["a", "open", 1], ["b", "closed", 0], ["c", "open", 3]] as const) {
      const m = await makeNodes(run, [{ nodeType: "work_item", externalId, title: externalId, content: "c", metadata: { status, priority } }]);
      ids.set(externalId, m.get(externalId)!);
    }
    await makeNodes(run, [{ nodeType: "note", externalId: "n", title: "n", content: "c", metadata: { status: "open" } }]);
    const { client } = await connectClient();

    const result = parseText(
      await client.callTool({
        name: "brain_list",
        arguments: { sourceSystems: [run.sourceSystem], nodeTypes: ["work_item"], where: [{ key: "status", op: "equals", value: "open" }] },
      }),
    );
    expect(result.nodes.map((n: any) => n.externalId)).toEqual(["c", "a"]);
    expect(result.nodes[0].metadata).toEqual({ status: "open", priority: 3 });
    expect(result.nodes[0].content).toBeUndefined();
    expect(result.nodes[0].cursor).toBeUndefined();
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();

    const first = parseText(await client.callTool({ name: "brain_list", arguments: { sourceSystems: [run.sourceSystem], limit: 2 } }));
    expect(first.nodes.map((n: any) => n.externalId)).toEqual(["n", "c"]);
    expect(first.hasMore).toBe(true);
    expect(first.truncationNote).toMatch(/nextCursor/);
    const second = parseText(await client.callTool({ name: "brain_list", arguments: { sourceSystems: [run.sourceSystem], limit: 2, cursor: first.nextCursor } }));
    expect(second.nodes.map((n: any) => n.externalId)).toEqual(["b", "a"]);
    expect(second.hasMore).toBe(false);

    const oneOf = parseText(await client.callTool({ name: "brain_list", arguments: { sourceSystems: [run.sourceSystem], where: [{ key: "priority", op: "oneOf", values: [0, 1] }] } }));
    expect(oneOf.nodes.map((n: any) => n.externalId).sort()).toEqual(["a", "b"]);
  });

  it("rejects a malformed predicate naming it, and works in read-only mode", async () => {
    const { client } = await connectClient({ readOnly: true });
    const raw = await client.callTool({ name: "brain_list", arguments: { where: [{ key: "status", op: "like", value: "x" }] } });
    expect(raw.isError).toBe(true);
    expect(firstText(raw)).toMatch(/where/);

    const ok = await client.callTool({ name: "brain_list", arguments: { sourceSystems: [`nothing-${uniqueSuffix()}`] } });
    expect(ok.isError).toBeFalsy();
    expect(parseText(ok).nodes).toEqual([]);
  });

  it("recomputes the cursor from what survived the response budget", async () => {
    const run = await newRun();
    for (const externalId of ["p1", "p2", "p3", "p4"]) {
      await makeNodes(run, [{ nodeType: "doc", externalId, title: "t".repeat(400), content: "c" }]);
    }
    const { client } = await connectClient({ responseCharBudget: 1400 });
    const page = parseText(await client.callTool({ name: "brain_list", arguments: { sourceSystems: [run.sourceSystem], limit: 4 } }));
    expect(page.truncated).toBe(true);
    expect(page.droppedNodeIds.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(true);
    // Each page fits fewer nodes than the limit, so walking to the end
    // takes several calls; the cursor must follow what was actually kept.
    const seen: string[] = page.nodes.map((n: any) => n.externalId);
    let cursor = page.nextCursor;
    let calls = 1;
    while (cursor !== null) {
      const next = parseText(await client.callTool({ name: "brain_list", arguments: { sourceSystems: [run.sourceSystem], limit: 4, cursor } }));
      seen.push(...next.nodes.map((n: any) => n.externalId));
      cursor = next.nextCursor;
      calls += 1;
      if (calls > 10) throw new Error("cursor did not converge");
    }
    expect(calls).toBeGreaterThan(2);
    expect(seen).toEqual(["p4", "p3", "p2", "p1"]);
  });
});

describe("brain_ready", () => {
  it("reports ready and blocked items with their blockers, scoped by specId (spec: agent asks what is ready)", async () => {
    const run = await newRun();
    const spec = `spec-${uniqueSuffix()}`;
    const m = await makeNodes(run, [
      { nodeType: "work_item", externalId: "A", title: "A", content: "c", metadata: { status: "closed", priority: 2, spec_id: spec } },
      { nodeType: "work_item", externalId: "B", title: "B", content: "c", metadata: { status: "open", priority: 0, spec_id: spec } },
      { nodeType: "work_item", externalId: "C", title: "C", content: "c", metadata: { status: "open", priority: 1, spec_id: spec } },
      { nodeType: "work_item", externalId: "D", title: "D", content: "c", metadata: { status: "open", priority: 2, spec_id: spec } },
    ]);
    await makeEdges(run, [
      { srcId: m.get("A")!, dstId: m.get("B")!, edgeType: "blocks" },
      { srcId: m.get("C")!, dstId: m.get("D")!, edgeType: "blocks" },
    ]);
    const { client } = await connectClient({ readOnly: true });

    const report = parseText(await client.callTool({ name: "brain_ready", arguments: { specId: spec } }));
    expect(report.ready.map((i: any) => i.externalId)).toEqual(["B", "C"]);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]).toMatchObject({ externalId: "D", openBlockerIds: [m.get("C")], inCycle: false });
    expect(report.cycleMemberIds).toEqual([]);
    expect(report.truncated).toBe(false);
  });
});

describe("brain_update_work_item", () => {
  it("closes a work item, stamps closedAt, names its run, and the change shows in brain_history (spec: agent closes a work item)", async () => {
    const src = `mcp-wi-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient(undefined, CLAUDE_CODE_CLIENT);

    const written = parseText(await client.callTool({ name: "brain_write", arguments: { items: { nodeType: "work_item", sourceSystem: src, externalId: "wi", title: "Ship it", content: "body" } } }));
    toolRunIds.push(written.ingestRunId);
    const id = written.items[0].id;

    const updated = parseText(await client.callTool({ name: "brain_update_work_item", arguments: { id, status: "closed", closedReason: "done" } }));
    toolRunIds.push(updated.ingestRunId);
    expect(updated).toMatchObject({ id, requestedId: id, resolvedFromMerge: false, action: "updated" });
    expect(updated.before).toMatchObject({ status: "open", priority: 2 });
    expect(updated.after).toMatchObject({ status: "closed", closedReason: "done" });
    expect(typeof updated.after.closedAt).toBe("string");

    const history = parseText(await client.callTool({ name: "brain_history", arguments: { id } }));
    expect(history.revisions[0]).toMatchObject({
      changedFields: ["metadata"],
      ingestRun: { id: updated.ingestRunId, sourceSystem: "agent", actor: CLAUDE_CODE_ACTOR },
    });
    expect(history.revisions[0].metadataChanges.status).toEqual({ before: "open", after: "closed" });

    const noop = parseText(await client.callTool({ name: "brain_update_work_item", arguments: { id, closedReason: "done" } }));
    toolRunIds.push(noop.ingestRunId);
    expect(noop.action).toBe("unchanged");
  });

  it("refuses a node that is not a work item, a bad patch, and read-only mode", async () => {
    const run = await newRun();
    const m = await makeNodes(run, [{ nodeType: "note", externalId: "n", title: "n", content: "c" }]);
    const { client } = await connectClient();

    const notItem = await client.callTool({ name: "brain_update_work_item", arguments: { id: m.get("n")!, status: "closed" } });
    expect(notItem.isError).toBe(true);
    expect(firstText(notItem)).toMatch(/not a work item/);

    const bad = await client.callTool({ name: "brain_update_work_item", arguments: { id: m.get("n")!, priority: 9 } });
    expect(bad.isError).toBe(true);

    const { client: ro } = await connectClient({ readOnly: true });
    const refused = await ro.callTool({ name: "brain_update_work_item", arguments: { id: m.get("n")!, status: "closed" } });
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toMatch(/read-only/i);
  });
});

describe("work-item contract in brain_write and cycles in brain_link", () => {
  it("rejects a batch containing a work item with a bad priority, naming the item and field, persisting nothing (spec: agent writes a work item with a bad priority)", async () => {
    const src = `mcp-wi-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const raw = await client.callTool({
      name: "brain_write",
      arguments: {
        items: [
          { nodeType: "work_item", sourceSystem: src, externalId: "good", title: "ok" },
          { nodeType: "work_item", sourceSystem: src, externalId: "bad", title: "bad", metadata: { priority: 7 } },
        ],
      },
    });
    expect(raw.isError).toBe(true);
    const text = firstText(raw);
    expect(text).toMatch(/priority/);
    expect(text).toMatch(/batch index 1/);
    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, src));
    expect(persisted).toHaveLength(0);
  });

  it("defaults a work item's status and priority on write", async () => {
    const src = `mcp-wi-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const written = parseText(await client.callTool({ name: "brain_write", arguments: { items: { nodeType: "work_item", sourceSystem: src, externalId: "d", title: "d" } } }));
    toolRunIds.push(written.ingestRunId);
    const got = parseText(await client.callTool({ name: "brain_get", arguments: { ids: [written.items[0].id] } }));
    expect(got.nodes[0].metadata).toEqual({ status: "open", priority: 2 });
  });

  it("refuses a blocks edge that closes a cycle, naming the path, storing nothing from the call (spec: agent links a cycle)", async () => {
    const run = await newRun();
    const m = await makeNodes(run, [
      { nodeType: "work_item", externalId: "A", title: "A", content: "c", metadata: { status: "open" } },
      { nodeType: "work_item", externalId: "B", title: "B", content: "c", metadata: { status: "open" } },
    ]);
    const a = m.get("A")!;
    const b = m.get("B")!;
    const { client } = await connectClient();

    const ok = parseText(await client.callTool({ name: "brain_link", arguments: { items: { srcId: a, dstId: b, edgeType: "blocks" } } }));
    toolRunIds.push(ok.ingestRunId);
    expect(ok.created).toBe(1);

    const raw = await client.callTool({ name: "brain_link", arguments: { items: [{ srcId: b, dstId: a, edgeType: "blocks" }, { srcId: a, dstId: b, edgeType: "mentions" }] } });
    expect(raw.isError).toBe(true);
    const text = firstText(raw);
    expect(text).toMatch(/cycle/);
    expect(text).toContain(`endpoints: ${b} -> ${a}`);
    expect(text).toMatch(/Nothing from this call was stored/);
    const stored = await db.select({ id: edges.id }).from(edges).where(and(eq(edges.srcId, a), eq(edges.edgeType, "mentions")));
    expect(stored).toHaveLength(0);
  });
});

describe("event-time contract in brain_write", () => {
  it("rejects a batch containing a node whose occurred_at does not parse, naming the item and occurred_at, persisting nothing (spec: agent writes a node with a bad event time)", async () => {
    const src = `mcp-time-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const raw = await client.callTool({
      name: "brain_write",
      arguments: {
        items: [
          { nodeType: "doc", sourceSystem: src, externalId: "good", title: "ok", metadata: { occurred_at: "2026-03-04T10:00:00+02:00" } },
          { nodeType: "doc", sourceSystem: src, externalId: "late", title: "late", metadata: { occurred_at: "last Tuesday" } },
        ],
      },
    });
    expect(raw.isError).toBe(true);
    const text = firstText(raw);
    expect(text).toMatch(/invalid event time at batch index 1/);
    expect(text).toMatch(/occurred_at \(got "last Tuesday"\)/);
    expect(text).toContain(`${src}/late`);
    expect(text).not.toMatch(/\s+at\s+\S+\s+\(/);

    // A work item's bad time is named as occurred_at too — the event-time
    // contract runs before the type's, on every type.
    const item = await client.callTool({
      name: "brain_write",
      arguments: { items: { nodeType: "work_item", sourceSystem: src, externalId: "wi", title: "wi", metadata: { status: "open", occurred_at: 1772611200000 } } },
    });
    expect(item.isError).toBe(true);
    expect(firstText(item)).toMatch(/invalid event time at batch index 0/);
    expect(firstText(item)).toMatch(/occurred_at \(got 1772611200000\)/);

    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, src));
    expect(persisted).toHaveLength(0);
  });

  it("stores a node of any type with occurred_at canonical, and null removes it (spec: agent writes a node with an event time)", async () => {
    const src = `mcp-time-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const written = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: {
          items: [
            { nodeType: "doc", sourceSystem: src, externalId: "zoned", title: "zoned", metadata: { occurred_at: "2026-03-04T10:00:00+02:00", note: "kept" } },
            { nodeType: "work_item", sourceSystem: src, externalId: "wi", title: "wi", metadata: { occurred_at: "2026-03-04T08:00:00Z" } },
            { nodeType: "doc", sourceSystem: src, externalId: "untimed", title: "untimed", metadata: { occurred_at: null, note: "kept" } },
          ],
        },
      }),
    );
    toolRunIds.push(written.ingestRunId);
    expect(written.created).toBe(3);
    const idOf = new Map<string, string>(written.items.map((i: { externalId: string; id: string }) => [i.externalId, i.id]));
    const got = parseText(await client.callTool({ name: "brain_get", arguments: { ids: [idOf.get("zoned")!, idOf.get("wi")!, idOf.get("untimed")!] } }));
    const byId = new Map<string, { metadata: Record<string, unknown> }>(got.nodes.map((n: { id: string; metadata: Record<string, unknown> }) => [n.id, n]));
    expect(byId.get(idOf.get("zoned")!)?.metadata).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z", note: "kept" });
    expect(byId.get(idOf.get("wi")!)?.metadata).toEqual({ status: "open", priority: 2, occurred_at: "2026-03-04T08:00:00.000Z" });
    expect(byId.get(idOf.get("untimed")!)?.metadata).toEqual({ note: "kept" });
  });
});

describe("view contract in brain_write and default_view resolution", () => {
  it("rejects a batch containing a view with an unknown renderer, naming the item and renderer, persisting nothing (spec: agent writes a view with an unknown renderer)", async () => {
    const src = `mcp-view-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const raw = await client.callTool({
      name: "brain_write",
      arguments: {
        items: [
          { nodeType: "doc", sourceSystem: src, externalId: "good", title: "ok" },
          { nodeType: "view", sourceSystem: src, externalId: "kanban-view", title: "Kanban", metadata: { renderer: "kanban", filter: { nodeTypes: ["work_item"] } } },
        ],
      },
    });
    expect(raw.isError).toBe(true);
    const text = firstText(raw);
    expect(text).toMatch(/renderer \(got "kanban"\)/);
    expect(text).toMatch(/batch index 1/);
    expect(text).toContain(`${src}/kanban-view`);
    expect(text).not.toMatch(/\s+at\s+\S+\s+\(/);
    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, src));
    expect(persisted).toHaveLength(0);
  });

  it("stores a timeline view whose filter names two node types (spec: agent writes a timeline view)", async () => {
    const src = `mcp-view-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const filter = { nodeTypes: ["gh-issue", "work_item"] };
    const written = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "view", sourceSystem: src, externalId: "history", title: "History", metadata: { renderer: "timeline", filter } } },
      }),
    );
    toolRunIds.push(written.ingestRunId);
    expect(written.created).toBe(1);
    const listed = parseText(await client.callTool({ name: "brain_list", arguments: { nodeTypes: ["view"], sourceSystems: [src] } }));
    expect(listed.nodes).toHaveLength(1);
    expect(listed.nodes[0]).toMatchObject({ id: written.items[0].id, metadata: { renderer: "timeline", filter } });
  });

  it("stores a view and a default_view edge; resolveDefaultViews names the view for the work item and its child_of descendant (spec: agent declares a default view)", async () => {
    const src = `mcp-view-${uniqueSuffix()}`;
    usedSourceSystems.push(src);
    const { client } = await connectClient();
    const filter = { nodeTypes: ["work_item"], where: [{ key: "status", op: "equals", value: "open" }] };

    const written = parseText(
      await client.callTool({
        name: "brain_write",
        arguments: {
          items: [
            { nodeType: "view", sourceSystem: src, externalId: "open-work", title: "Open work", metadata: { renderer: "feed", filter, note: "kept" } },
            { nodeType: "work_item", sourceSystem: src, externalId: "epic", title: "Epic" },
            { nodeType: "work_item", sourceSystem: src, externalId: "task", title: "Task" },
          ],
        },
      }),
    );
    toolRunIds.push(written.ingestRunId);
    const idOf = new Map<string, string>(written.items.map((i: { externalId: string; id: string }) => [i.externalId, i.id]));
    const view = idOf.get("open-work")!;
    const epic = idOf.get("epic")!;
    const task = idOf.get("task")!;

    const linked = parseText(
      await client.callTool({
        name: "brain_link",
        arguments: {
          items: [
            { srcId: task, dstId: epic, edgeType: "child_of" },
            { srcId: epic, dstId: view, edgeType: "default_view" },
          ],
        },
      }),
    );
    toolRunIds.push(linked.ingestRunId);
    expect(linked.created).toBe(2);

    const listed = parseText(await client.callTool({ name: "brain_list", arguments: { nodeTypes: ["view"], sourceSystems: [src] } }));
    expect(listed.nodes).toHaveLength(1);
    expect(listed.nodes[0]).toMatchObject({ id: view, metadata: { renderer: "feed", filter, note: "kept" } });

    expect(await resolveDefaultViews(db, [epic, task])).toEqual([
      { nodeId: epic, view: { id: view, title: "Open work", renderer: "feed" }, declaredBy: epic },
      { nodeId: task, view: { id: view, title: "Open work", renderer: "feed" }, declaredBy: epic },
    ]);
  });
});


describe("brain_ready under a tight response budget", () => {
  it("drops blocked items before ready ones and names blockedLimit in the note", async () => {
    const run = await newRun();
    const spec = `spec-${uniqueSuffix()}`;
    // Ready items are small; blocked items carry long titles so the budget
    // cuts into the blocked list well before it reaches the ready list.
    const specs = ["r1", "r2", "b1", "b2", "b3", "x"].map((externalId, i) => ({
      nodeType: "work_item",
      externalId,
      title: externalId.startsWith("b") ? `${externalId} ${"t".repeat(200)}` : externalId,
      content: "c",
      metadata: { status: "open", priority: i, spec_id: spec },
    }));
    const m = await makeNodes(run, specs);
    await makeEdges(run, ["b1", "b2", "b3"].map((id) => ({ srcId: m.get("x")!, dstId: m.get(id)!, edgeType: "blocks" })));
    const { client } = await connectClient({ readOnly: true, responseCharBudget: 1500 });

    const report = parseText(await client.callTool({ name: "brain_ready", arguments: { specId: spec } }));
    expect(report.truncated).toBe(true);
    expect(report.droppedBlockedIds.length).toBeGreaterThan(0);
    expect(report.droppedReadyIds).toEqual([]);
    expect(report.ready.map((i: any) => i.externalId)).toEqual(["r1", "r2", "x"]);
    expect(report.blockedHasMore).toBe(true);
    expect(report.readyHasMore).toBe(false);
    expect(report.truncationNote).toMatch(/blockedLimit/);
    expect(report.truncationNote).not.toMatch(/readyLimit/);
    for (const b of report.blocked) expect(b.kind).toBeUndefined();
  });
});
