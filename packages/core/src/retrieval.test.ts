import { inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { EmptyQueryError, InvalidRetrievalOptionError } from "./errors.js";
import type { EdgeInput } from "./edges.js";
import { upsertEdges } from "./edges.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import type { NodeInput } from "./nodes.js";
import { upsertNodes } from "./nodes.js";
import { buildRetrievalQuery, getStoreSummary, retrieve, type BuildRetrievalQueryParams } from "./retrieval.js";
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
  const run = await openIngestRun(db, `retrieval-test-${uniqueSuffix()}`);
  openRunIds.push(run.id);
  usedSourceSystems.push(run.sourceSystem);
  return run;
}

/** Creates nodes for `run` and returns a map from `externalId` to the assigned `id`. */
async function makeNodes(run: IngestRunHandle, specs: readonly Omit<NodeInput, "sourceSystem">[]): Promise<Map<string, string>> {
  const input: NodeInput[] = specs.map((s) => ({ ...s, sourceSystem: run.sourceSystem }));
  const result = await upsertNodes(db, run, input);
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

async function makeEdges(run: IngestRunHandle, specs: readonly Omit<EdgeInput, "sourceSystem">[]): Promise<void> {
  const input: EdgeInput[] = specs.map((e) => ({ ...e, sourceSystem: run.sourceSystem }));
  await upsertEdges(db, run, input);
}

/**
 * Counts how many statements `db.execute()` issues while `fn` runs — used
 * to verify the retrieval spec's "Single round-trip execution" hard
 * constraint directly against the real driver, not by inspecting SQL text.
 */
async function countExecuteCalls<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const original = db.execute.bind(db);
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).execute = (...args: unknown[]) => {
    count += 1;
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    const result = await fn();
    return { result, count };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).execute = original;
  }
}

// --- buildRetrievalQuery: pure function, no database ------------------------

describe("buildRetrievalQuery", () => {
  const dialect = new PgDialect();
  const baseParams: BuildRetrievalQueryParams = {
    seedStrategy: "exact",
    queryText: "example query",
    seedLimit: 10,
    minRelevance: 1e-6,
    maxDepth: 2,
    fanout: 25,
    nodeBudget: 40,
    decay: 0.6,
    nodeTypes: null,
    sourceSystems: null,
    edgeTypes: null,
    updatedSince: null,
  };

  it("is pure: the same params produce identical SQL text and params on every call", () => {
    const a = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    const b = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });

  it("uses websearch_to_tsquery/ts_rank_cd for the exact strategy and word_similarity/<% for fuzzy", () => {
    const exact = dialect.sqlToQuery(buildRetrievalQuery({ ...baseParams, seedStrategy: "exact" }));
    expect(exact.sql).toContain("websearch_to_tsquery");
    expect(exact.sql).toContain("ts_rank_cd");
    expect(exact.sql).not.toContain("word_similarity");

    const fuzzy = dialect.sqlToQuery(buildRetrievalQuery({ ...baseParams, seedStrategy: "fuzzy" }));
    expect(fuzzy.sql).toContain("word_similarity");
    expect(fuzzy.sql).toContain("<%");
    // Fuzzy seeds have no tsquery to highlight against — snippet is
    // unconditionally NULL, not a CASE over ts_headline.
    expect(fuzzy.sql).toContain("NULL::text AS snippet");
  });

  it("places LATERAL...LIMIT and CYCLE inside the recursive term, not a subquery", () => {
    const { sql: text } = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    expect(text).toMatch(/WITH RECURSIVE/);
    expect(text).toContain("CROSS JOIN LATERAL");
    expect(text).toContain("CYCLE node_id SET is_cycle USING cycle_path");
  });

  it("renders NULL::text[] for an unset array filter and a bound ARRAY[...] for a set one", () => {
    const unset = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    expect(unset.sql).toContain("NULL::text[]");
    expect(unset.sql).not.toContain("ARRAY[$");

    const set = dialect.sqlToQuery(buildRetrievalQuery({ ...baseParams, nodeTypes: ["doc", "spec"] }));
    expect(set.sql).toContain("ARRAY[$");
    expect(set.params).toContain("doc");
    expect(set.params).toContain("spec");
  });

  it("renders NULL::timestamptz for an unset updatedSince and a bound value for a set one", () => {
    const unset = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    expect(unset.sql).toContain("NULL::timestamptz");

    const when = new Date("2026-01-01T00:00:00.000Z");
    const set = dialect.sqlToQuery(buildRetrievalQuery({ ...baseParams, updatedSince: when }));
    expect(set.params).toContain(when.toISOString());
  });

  it("contains no semicolon — it is exactly one statement", () => {
    const { sql: text } = dialect.sqlToQuery(buildRetrievalQuery(baseParams));
    expect(text).not.toContain(";");
  });
});

// --- retrieve(): one test per retrieval spec scenario ------------------------

describe("retrieve", () => {
  it("returns at most seedLimit seeds ordered by descending relevance, each with a score and a highlighting snippet (spec: Query with clear matches)", async () => {
    const run = await newRun();
    await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Batch upsert everywhere", content: "batch upsert batch upsert batch upsert design notes" },
      { nodeType: "doc", externalId: "n2", title: "Batch upsert twice", content: "batch upsert appears here and batch upsert again" },
      { nodeType: "doc", externalId: "n3", title: "Batch upsert once", content: "a single batch upsert mention" },
      { nodeType: "doc", externalId: "n4", title: "Batch upsert rarely", content: "batch upsert shows up just once more" },
      { nodeType: "doc", externalId: "n5", title: "Batch upsert barely", content: "batch upsert, barely relevant here" },
      { nodeType: "doc", externalId: "n6", title: "Batch upsert extra", content: "another batch upsert doc to exceed the seed limit" },
      { nodeType: "doc", externalId: "n7", title: "Unrelated", content: "nothing about the topic here at all" },
    ]);

    const result = await retrieve(db, "batch upsert", { seedLimit: 3, sourceSystems: [run.sourceSystem] });
    expect(result.mode).toBe("exact");
    if (result.mode === "empty") throw new Error("expected a found result");

    expect(result.seedCount).toBeLessThanOrEqual(3);
    expect(result.seedCount).toBeGreaterThan(0);
    const seeds = result.nodes.filter((n) => n.isSeed);
    expect(seeds).toHaveLength(result.seedCount);
    expect(seeds.some((n) => n.externalId === "n7")).toBe(false);

    for (let i = 1; i < seeds.length; i++) {
      expect(seeds[i - 1]!.relevance!).toBeGreaterThanOrEqual(seeds[i]!.relevance!);
    }
    for (const seed of seeds) {
      expect(seed.snippet).toBeTruthy();
      expect(seed.snippet).toContain("[[");
    }
  });

  it("supports exclusion, quoted phrase, and alternation syntax (spec: Phrase and exclusion syntax)", async () => {
    const run = await newRun();
    await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Postgres notes", content: "postgres is a relational database" },
      { nodeType: "doc", externalId: "n2", title: "Postgres and supabase", content: "postgres paired with supabase for hosting" },
      // Contains both "relational" and "database" as separate, non-adjacent
      // words — the negative control for the quoted-phrase assertion below:
      // a phrase match requires adjacency, not just co-occurrence.
      { nodeType: "doc", externalId: "n3", title: "Database theory", content: "the theory is relational but this is not directly about a database" },
    ]);

    // Exclusion: matches the positive term, excludes documents containing
    // the excluded term.
    const exclusion = await retrieve(db, "postgres -supabase", { sourceSystems: [run.sourceSystem] });
    if (exclusion.mode === "empty") throw new Error("expected a found result");
    const exclusionIds = exclusion.nodes.map((n) => n.externalId);
    expect(exclusionIds).toContain("n1");
    expect(exclusionIds).not.toContain("n2");

    // Quoted phrase: requires the terms adjacent and in order, so it
    // matches n1 ("relational database") but not n3 (same two words,
    // apart).
    const phrase = await retrieve(db, '"relational database"', { sourceSystems: [run.sourceSystem] });
    if (phrase.mode === "empty") throw new Error("expected a found result");
    const phraseIds = phrase.nodes.map((n) => n.externalId);
    expect(phraseIds).toContain("n1");
    expect(phraseIds).not.toContain("n3");

    // Alternation: unions documents matching either term, so it matches
    // n1 (via "relational") and n2 (via "hosting") even though neither
    // contains both terms.
    const alternation = await retrieve(db, "relational or hosting", { sourceSystems: [run.sourceSystem] });
    if (alternation.mode === "empty") throw new Error("expected a found result");
    const alternationIds = alternation.nodes.map((n) => n.externalId);
    expect(alternationIds).toContain("n1");
    expect(alternationIds).toContain("n2");
  });

  it("returns an empty seed set without error when every candidate scores below minRelevance (spec: Query below the relevance floor)", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Batch upsert", content: "batch upsert design notes" }]);

    // Exercised directly through the pure query builder + a single
    // db.execute — this is specifically the seed-selection behavior the
    // scenario describes, independent of retrieve()'s fuzzy escalation
    // (which has its own scenario below).
    const query = buildRetrievalQuery({
      seedStrategy: "exact",
      queryText: "batch upsert",
      seedLimit: 10,
      minRelevance: 1000, // no real ts_rank_cd score reaches this
      maxDepth: 2,
      fanout: 25,
      nodeBudget: 40,
      decay: 0.6,
      nodeTypes: null,
      sourceSystems: [run.sourceSystem],
      edgeTypes: null,
      updatedSince: null,
    });
    const result = await db.execute<{ result: { seed_count: number; node_count: number } }>(query);
    const envelope = result.rows[0]!.result;
    expect(envelope.seed_count).toBe(0);
    expect(envelope.node_count).toBe(0);
  });

  it("falls back to fuzzy matching, flags the result as fuzzy, and still expands into a subgraph when full-text search finds nothing (spec: Misspelled query)", async () => {
    const run = await newRun();
    // n2 deliberately never mentions "postgres" itself — it must be
    // reachable only by traversing from n1, not by also matching the
    // fuzzy query on its own content.
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Postgres internals", content: "deep dive into postgres storage layout" },
      { nodeType: "doc", externalId: "n2", title: "Related reading", content: "more context connected to the storage internals doc" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "mentions", weight: 0.8 }]);

    const result = await retrieve(db, "postgress", { sourceSystems: [run.sourceSystem] }); // misspelled
    expect(result.mode).toBe("fuzzy");
    if (result.mode === "empty") throw new Error("expected a found result");
    expect(result.seedCount).toBeGreaterThan(0);

    const seed = result.nodes.find((n) => n.externalId === "n1");
    expect(seed?.isSeed).toBe(true);
    expect(seed?.snippet).toBeNull();

    const expanded = result.nodes.find((n) => n.externalId === "n2");
    expect(expanded).toBeDefined();
    expect(expanded?.isSeed).toBe(false);
    expect(expanded?.seedId).toBe(seed?.id);
  });

  it("returns an empty result stating both modes were tried when neither exact nor fuzzy matching finds anything (spec: Fuzzy fallback also finds nothing)", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Completely unrelated", content: "gardening and cooking tips" }]);

    const result = await retrieve(db, "quantumelectrodynamics", { sourceSystems: [run.sourceSystem] });
    expect(result).toEqual({ mode: "empty", triedModes: ["exact", "fuzzy"], nodes: [], edges: [] });
  });

  it("returns only nodes within maxDepth hops of a seed when the neighborhood is deeper (spec: Depth bound reached)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Chain root topic", content: "chain root topic unique phrase alpha" },
      { nodeType: "doc", externalId: "n2", title: "Hop one", content: "hop one" },
      { nodeType: "doc", externalId: "n3", title: "Hop two", content: "hop two" },
      { nodeType: "doc", externalId: "n4", title: "Hop three", content: "hop three" },
      { nodeType: "doc", externalId: "n5", title: "Hop four", content: "hop four" },
    ]);
    await makeEdges(run, [
      { srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n2")!, dstId: nodeMap.get("n3")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n3")!, dstId: nodeMap.get("n4")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n4")!, dstId: nodeMap.get("n5")!, edgeType: "next", weight: 1 },
    ]);

    const result = await retrieve(db, "chain root topic alpha", { maxDepth: 2, sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const externalIds = new Set(result.nodes.map((n) => n.externalId));
    expect(externalIds).toEqual(new Set(["n1", "n2", "n3"]));
  });

  it("succeeds at maxDepth: 3, the hard ceiling — nothing else drives that bound to its actual limit", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Ceiling chain root", content: "ceiling chain root unique phrase omega" },
      { nodeType: "doc", externalId: "n2", title: "Ceiling hop one", content: "ceiling hop one" },
      { nodeType: "doc", externalId: "n3", title: "Ceiling hop two", content: "ceiling hop two" },
      { nodeType: "doc", externalId: "n4", title: "Ceiling hop three", content: "ceiling hop three" },
      { nodeType: "doc", externalId: "n5", title: "Ceiling hop four", content: "ceiling hop four" },
    ]);
    await makeEdges(run, [
      { srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n2")!, dstId: nodeMap.get("n3")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n3")!, dstId: nodeMap.get("n4")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n4")!, dstId: nodeMap.get("n5")!, edgeType: "next", weight: 1 },
    ]);

    const result = await retrieve(db, "ceiling chain root omega", { maxDepth: 3, nodeBudget: 40, sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const externalIds = new Set(result.nodes.map((n) => n.externalId));
    // Exactly one hop further than the maxDepth: 2 test above — n4 (depth
    // 3) is now included, n5 (depth 4) still is not.
    expect(externalIds).toEqual(new Set(["n1", "n2", "n3", "n4"]));
  });

  it("keeps exactly nodeBudget nodes, retaining the highest scoring ones, when the neighborhood is larger (spec: Node budget reached)", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [
      { nodeType: "doc", externalId: "seed", title: "Budget test root", content: "budget test root unique phrase beta" },
    ];
    for (let i = 1; i <= 10; i++) {
      specs.push({ nodeType: "doc", externalId: `leaf${i}`, title: `Leaf ${i}`, content: `leaf ${i}` });
    }
    const nodeMap = await makeNodes(run, specs);
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 10; i++) {
      edgeSpecs.push({ srcId: nodeMap.get("seed")!, dstId: nodeMap.get(`leaf${i}`)!, edgeType: "leaf", weight: i / 10 });
    }
    await makeEdges(run, edgeSpecs);

    const result = await retrieve(db, "budget test root beta", { nodeBudget: 5, fanout: 25, sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    expect(result.nodeCount).toBe(5);
    expect(result.truncated).toBe(true);
    const externalIds = new Set(result.nodes.map((n) => n.externalId));
    // The seed itself always scores highest (weight/decay <= 1), plus the
    // 4 highest-weight leaves.
    expect(externalIds).toEqual(new Set(["seed", "leaf10", "leaf9", "leaf8", "leaf7"]));
  });

  it("visits a cyclic node once and terminates rather than looping (spec: Cycle in the graph)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Cycle root", content: "cycle root unique phrase gamma" },
      { nodeType: "doc", externalId: "n2", title: "Cycle partner", content: "cycle partner" },
    ]);
    await makeEdges(run, [
      { srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "loop", weight: 1 },
      { srcId: nodeMap.get("n2")!, dstId: nodeMap.get("n1")!, edgeType: "loop", weight: 1 },
    ]);

    const result = await retrieve(db, "cycle root gamma", { sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const externalIds = result.nodes.map((n) => n.externalId).sort();
    expect(externalIds).toEqual(["n1", "n2"]);
    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("caps a hub node's neighbors entering the frontier at fanout, choosing the highest-weight ones (spec: Hub node with many neighbors)", async () => {
    const run = await newRun();
    const specs: Omit<NodeInput, "sourceSystem">[] = [
      { nodeType: "doc", externalId: "hub", title: "Hub root", content: "hub root unique phrase delta" },
    ];
    for (let i = 1; i <= 12; i++) {
      specs.push({ nodeType: "doc", externalId: `nbr${i}`, title: `Neighbor ${i}`, content: `neighbor ${i}` });
    }
    const nodeMap = await makeNodes(run, specs);
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= 12; i++) {
      edgeSpecs.push({ srcId: nodeMap.get("hub")!, dstId: nodeMap.get(`nbr${i}`)!, edgeType: "hub_edge", weight: i / 12 });
    }
    await makeEdges(run, edgeSpecs);

    const result = await retrieve(db, "hub root delta", { fanout: 3, nodeBudget: 40, sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const neighbors = result.nodes.filter((n) => n.externalId.startsWith("nbr"));
    expect(neighbors).toHaveLength(3);
    const externalIds = new Set(neighbors.map((n) => n.externalId));
    expect(externalIds).toEqual(new Set(["nbr12", "nbr11", "nbr10"]));
  });

  it("caps a hub node's neighbors at fanout even with hundreds of candidates (spec: Hub node with many neighbors, at review-tested scale — 500 neighbours against a cap of 10)", async () => {
    const run = await newRun();
    const NEIGHBOR_COUNT = 500;
    const FANOUT = 10;
    const specs: Omit<NodeInput, "sourceSystem">[] = [
      { nodeType: "doc", externalId: "hub", title: "Mega hub root", content: "mega hub root unique phrase omicron" },
    ];
    for (let i = 1; i <= NEIGHBOR_COUNT; i++) {
      specs.push({ nodeType: "doc", externalId: `mnbr${i}`, title: `Mega neighbor ${i}`, content: `mega neighbor ${i}` });
    }
    const nodeMap = await makeNodes(run, specs);
    const edgeSpecs: Omit<EdgeInput, "sourceSystem">[] = [];
    for (let i = 1; i <= NEIGHBOR_COUNT; i++) {
      // Distinct weights so the top-FANOUT set is unambiguous.
      edgeSpecs.push({ srcId: nodeMap.get("hub")!, dstId: nodeMap.get(`mnbr${i}`)!, edgeType: "hub_edge", weight: i / NEIGHBOR_COUNT });
    }
    await makeEdges(run, edgeSpecs);

    const result = await retrieve(db, "mega hub root omicron", { fanout: FANOUT, nodeBudget: 40, sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const neighbors = result.nodes.filter((n) => n.externalId.startsWith("mnbr"));
    expect(neighbors).toHaveLength(FANOUT);
    const expectedTop = new Set(
      Array.from({ length: FANOUT }, (_, i) => `mnbr${NEIGHBOR_COUNT - i}`), // mnbr500..mnbr491: highest weights
    );
    expect(new Set(neighbors.map((n) => n.externalId))).toEqual(expectedTop);
  });

  it("returns byte-identical serialized results for the same query run twice, compared as the envelope itself rather than a re-sorted copy (spec: Repeated identical query; extra test 3)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Determinism root", content: "determinism root unique phrase epsilon" },
      { nodeType: "doc", externalId: "n2", title: "Determinism leaf", content: "determinism leaf" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "next", weight: 0.7 }]);

    const [first, second] = await Promise.all([
      retrieve(db, "determinism root epsilon", { sourceSystems: [run.sourceSystem] }),
      retrieve(db, "determinism root epsilon", { sourceSystems: [run.sourceSystem] }),
    ]);

    // Compared as the serialized envelope the caller actually receives —
    // not sorted arrays re-derived from it — so a real ordering bug (every
    // ORDER BY in the design must end in a total tie-break) shows up as a
    // mismatch here instead of being silently normalized away.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("issues exactly one database statement when the exact path finds seeds (spec: Retrieval issues one query)", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Single statement check", content: "single statement check unique phrase zeta" }]);

    const { result, count } = await countExecuteCalls(() =>
      retrieve(db, "single statement check zeta", { sourceSystems: [run.sourceSystem] }),
    );
    if (result.mode === "empty") throw new Error("expected a found result");
    expect(count).toBe(1);
  });

  it("issues a second statement only when the exact path finds zero seeds (fuzzy fallback is the one documented exception)", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Fallback statement check", content: "fallback statement check unique phrase eta" }]);

    const { count } = await countExecuteCalls(() =>
      // Misspelled so the exact statement reports zero seeds and the
      // fuzzy statement must find "fallback".
      retrieve(db, "fallbackk statementt checkk", { sourceSystems: [run.sourceSystem] }),
    );
    expect(count).toBe(2);
  });

  it("excludes nodes from another source system when filtered to one (spec: Restricting to one source system)", async () => {
    const runA = await newRun();
    const runB = await newRun();
    await makeNodes(runA, [{ nodeType: "doc", externalId: "a1", title: "Source filter test", content: "source filter test unique phrase theta" }]);
    await makeNodes(runB, [{ nodeType: "doc", externalId: "b1", title: "Source filter test", content: "source filter test unique phrase theta" }]);

    const result = await retrieve(db, "source filter test theta", { sourceSystems: [runA.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const sources = new Set(result.nodes.map((n) => n.sourceSystem));
    expect(sources).toEqual(new Set([runA.sourceSystem]));
  });

  it("excludes a node reachable only through a filtered-out node, rather than merely hiding it from output (spec: Filtered-out node blocks the path behind it; extra test 2)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "kept-type", externalId: "n1", title: "Filter chain root", content: "filter chain root unique phrase iota" },
      { nodeType: "excluded-type", externalId: "n2", title: "Filter chain middle", content: "filter chain middle" },
      { nodeType: "kept-type", externalId: "n3", title: "Filter chain end", content: "filter chain end" },
    ]);
    await makeEdges(run, [
      { srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "next", weight: 1 },
      { srcId: nodeMap.get("n2")!, dstId: nodeMap.get("n3")!, edgeType: "next", weight: 1 },
    ]);

    const result = await retrieve(db, "filter chain root iota", {
      nodeTypes: ["kept-type"],
      sourceSystems: [run.sourceSystem],
    });
    if (result.mode === "empty") throw new Error("expected a found result");
    const externalIds = new Set(result.nodes.map((n) => n.externalId));
    // n3 is "kept-type" but reachable only via n2 ("excluded-type") — it
    // must be absent, not merely present-but-unreachable-looking.
    expect(externalIds).toEqual(new Set(["n1"]));
  });

  it("excludes a text-matching node from seed selection itself when its type is filtered out, not merely from expansion afterward", async () => {
    const run = await newRun();
    await makeNodes(run, [
      { nodeType: "excluded-type", externalId: "n1", title: "Seed selection filter probe", content: "seed selection filter probe unique phrase pi" },
      { nodeType: "kept-type", externalId: "n2", title: "Unrelated kept node", content: "completely unrelated content" },
    ]);

    const result = await retrieve(db, "seed selection filter probe pi", {
      nodeTypes: ["kept-type"],
      sourceSystems: [run.sourceSystem],
    });
    // n1 is the only node whose content matches the query text at all,
    // but its type is filtered out. There is no edge here for traversal
    // to run through — n1 can only be excluded by the filter applying
    // inside seed SELECTION itself (the `seeds` CTE), not by a later
    // expansion-only filter, so the whole call must come back empty
    // rather than returning n1 as an (unfiltered) seed.
    expect(result).toEqual({ mode: "empty", triedModes: ["exact", "fuzzy"], nodes: [], edges: [] });
  });

  it("returns an empty seed set, not an arbitrary slice of the store, for a query with only an exclusion term (spec: Query matching only excluded terms)", async () => {
    const run = await newRun();
    await makeNodes(run, [{ nodeType: "doc", externalId: "n1", title: "Some content", content: "some content without the excluded term" }]);

    const query = buildRetrievalQuery({
      seedStrategy: "exact",
      queryText: "-supabase",
      seedLimit: 10,
      minRelevance: 1e-6,
      maxDepth: 2,
      fanout: 25,
      nodeBudget: 40,
      decay: 0.6,
      nodeTypes: null,
      sourceSystems: [run.sourceSystem],
      edgeTypes: null,
      updatedSince: null,
    });
    const result = await db.execute<{ result: { seed_count: number } }>(query);
    expect(result.rows[0]!.result.seed_count).toBe(0);
  });

  it("reports the seed and edge types traversed for a node that was not itself a seed (spec: Node reached by traversal)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Provenance root", content: "provenance root unique phrase kappa" },
      { nodeType: "doc", externalId: "n2", title: "Provenance leaf", content: "provenance leaf" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "mentions", weight: 0.5 }]);

    const result = await retrieve(db, "provenance root kappa", { sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const seed = result.nodes.find((n) => n.externalId === "n1")!;
    const leaf = result.nodes.find((n) => n.externalId === "n2")!;
    expect(leaf.isSeed).toBe(false);
    expect(leaf.seedId).toBe(seed.id);
    expect(leaf.edgePath).toEqual(["mentions"]);
    expect(leaf.viaEdgeId).toBeTruthy();
  });

  it("returns the survivor exactly once when both it and its merged-away alias match the query (extra test 1, docs/retrieval-query-design.md)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Merge fold survivor", content: "merge fold unique phrase lambda on the survivor" },
      { nodeType: "doc", externalId: "loser", title: "Merge fold loser", content: "merge fold unique phrase lambda on the loser" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    await mergeNodes(db, loserId, survivorId);

    const result = await retrieve(db, "merge fold lambda", { sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const matches = result.nodes.filter((n) => n.id === survivorId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.isSeed).toBe(true);
    expect(result.nodes.some((n) => n.id === loserId)).toBe(false);
  });

  it("returns the survivor as a seed via its merged-away alias when only the loser's content matches (proves the fold, not coincidence — the survivor's own content does not match)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "survivor", title: "Merge fold survivor only", content: "gardening and cooking tips, nothing about the search term at all" },
      { nodeType: "doc", externalId: "loser", title: "Merge fold loser only", content: "merge fold loser-only unique phrase rho" },
    ]);
    const survivorId = nodeMap.get("survivor")!;
    const loserId = nodeMap.get("loser")!;
    await mergeNodes(db, loserId, survivorId);

    const result = await retrieve(db, "merge fold loser-only rho", { sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    const matches = result.nodes.filter((n) => n.id === survivorId);
    expect(matches).toHaveLength(1);
    const match = matches[0]!;
    expect(match.isSeed).toBe(true);
    // The row that actually matched is the loser, not the survivor's own
    // (unrelated) content — this is what distinguishes a real fold from
    // the survivor happening to match on its own.
    expect(match.matchedNodeId).toBe(loserId);
    expect(match.snippet).toContain("[[");
    expect(result.nodes.some((n) => n.id === loserId)).toBe(false);
  });

  it("excludes a merge-induced self-loop from result_edges: L -[rel]-> S folds to a self-reference once L is merged into S, and that must not be returned", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "loser", title: "Self loop loser", content: "self loop unique phrase sigma loser side" },
      { nodeType: "doc", externalId: "survivor", title: "Self loop survivor", content: "self loop unique phrase sigma survivor side" },
    ]);
    const loserId = nodeMap.get("loser")!;
    const survivorId = nodeMap.get("survivor")!;
    await makeEdges(run, [{ srcId: loserId, dstId: survivorId, edgeType: "mentions", weight: 0.9 }]);
    await mergeNodes(db, loserId, survivorId);

    // Query matches the survivor directly, so the survivor is a seed and
    // the (now folded) loser->survivor edge is in scope for result_edges
    // via the alias probe on the survivor's own kept_probe row.
    const result = await retrieve(db, "self loop sigma survivor", { sourceSystems: [run.sourceSystem] });
    if (result.mode === "empty") throw new Error("expected a found result");
    expect(result.nodes.some((n) => n.id === survivorId)).toBe(true);
    const selfLoops = result.edges.filter((e) => e.srcNodeId === e.dstNodeId);
    expect(selfLoops).toEqual([]);
  });

  it("rejects the empty/whitespace-only query with EmptyQueryError, before any SQL runs", async () => {
    await expect(retrieve(db, "   ")).rejects.toBeInstanceOf(EmptyQueryError);
  });

  it("rejects a query that parses to zero tsquery nodes (stopwords only) with EmptyQueryError, in exactly one statement", async () => {
    // "the of and" are all English stopwords: websearch_to_tsquery parses
    // this down to zero lexemes (numnode = 0) — see
    // docs/retrieval-query-design.md, "Implementation notes", and the
    // EmptyQueryError doc comment in errors.ts. Detection rides on the
    // exact statement's own envelope (`query_node_count`), specifically
    // so this does not cost a preliminary round trip — asserted here at
    // the driver level, not just by reading the SQL.
    const { result: rejection, count } = await countExecuteCalls(() =>
      retrieve(db, "the of and").catch((err: unknown) => err),
    );
    expect(rejection).toBeInstanceOf(EmptyQueryError);
    expect(count).toBe(1);
  });

  it("rejects a non-positive minRelevance with InvalidRetrievalOptionError, before any SQL runs", async () => {
    const { result: rejection, count } = await countExecuteCalls(() =>
      retrieve(db, "anything", { minRelevance: 0 }).catch((err: unknown) => err),
    );
    expect(rejection).toBeInstanceOf(InvalidRetrievalOptionError);
    expect(count).toBe(0);
  });

  it("rejects a maxDepth beyond the hard ceiling of 3 with InvalidRetrievalOptionError", async () => {
    await expect(retrieve(db, "anything", { maxDepth: 4 })).rejects.toBeInstanceOf(InvalidRetrievalOptionError);
  });

  it("rejects an empty filter array, since [] ('match nothing') and omitted/null ('no filter') are different intents", async () => {
    await expect(retrieve(db, "anything", { nodeTypes: [] })).rejects.toBeInstanceOf(InvalidRetrievalOptionError);
  });
});

// --- getStoreSummary ----------------------------------------------------------

describe("getStoreSummary", () => {
  it("reports node types, source systems, and edge types with counts, plus recently updated nodes (spec: Caller orients before searching)", async () => {
    const run = await newRun();
    const nodeMap = await makeNodes(run, [
      { nodeType: "doc", externalId: "n1", title: "Summary doc", content: "summary content" },
      { nodeType: "spec", externalId: "n2", title: "Summary spec", content: "summary content" },
    ]);
    await makeEdges(run, [{ srcId: nodeMap.get("n1")!, dstId: nodeMap.get("n2")!, edgeType: "relates_to", weight: 0.5 }]);

    const summary = await getStoreSummary(db, { recentNodesLimit: 100 });

    const docType = summary.nodeTypes.find((t) => t.nodeType === "doc");
    expect(docType).toBeDefined();
    expect(docType!.count).toBeGreaterThanOrEqual(1);

    const sourceEntry = summary.sourceSystems.find((s) => s.sourceSystem === run.sourceSystem);
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry!.count).toBe(2);

    const edgeTypeEntry = summary.edgeTypes.find((e) => e.edgeType === "relates_to");
    expect(edgeTypeEntry).toBeDefined();
    expect(edgeTypeEntry!.count).toBeGreaterThanOrEqual(1);

    const recentIds = new Set(summary.recentNodes.map((n) => n.id));
    expect(recentIds.has(nodeMap.get("n1")!) || recentIds.has(nodeMap.get("n2")!)).toBe(true);
    for (const n of summary.recentNodes) {
      expect(n.updatedAt).toBeInstanceOf(Date);
    }
  });

  it("rejects a non-positive recentNodesLimit with InvalidRetrievalOptionError", async () => {
    await expect(getStoreSummary(db, { recentNodesLimit: 0 })).rejects.toBeInstanceOf(InvalidRetrievalOptionError);
  });
});
