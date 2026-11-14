import { inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { EmptyQueryError, InvalidListOptionError } from "./errors.js";
import { buildFindNodesQuery, findNodes, MAX_FIND_LIMIT, MAX_FIND_OFFSET, MAX_FIND_TEXT_LENGTH, type FindNodesOptions, type FoundNode } from "./find.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { MAX_LIST_NAMES } from "./list.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes, type NodeInput } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

// The store is shared with other suites, other agents, and real data, so
// every fixture here is scoped: a unique source system (cleanup), unique
// node types and projects, and purely alphabetic text tokens (a digit-letter
// run tokenizes unpredictably). Every text query names a fixture token and
// every no-text query chooses a fixture project, so no assertion ever
// depends on a store-wide number.
const SUFFIX = uniqueSuffix();
const SRC = `find-test-${SUFFIX}`;
const P = `find-p-${SUFFIX}`;
const Q = `find-q-${SUFFIX}`;
const TA = `find-a-${SUFFIX}`;
const TB = `find-b-${SUFFIX}`;
const word = () => uniqueSuffix().replace(/\d/g, (d) => "ghijklmnop"[Number(d)] ?? "g");
const TOKEN = word();
const RANK = word();
const TIE = word();
const MERGED_ONLY = word();
const SHARED = word();
const PAGE = word();

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
const ids: Record<string, string> = {};

type Fixture = { key: string; nodeType: string; title: string; content: string; metadata: Record<string, unknown> };

async function write(fixtures: readonly Fixture[]): Promise<void> {
  const input: NodeInput[] = fixtures.map((f) => ({ sourceSystem: SRC, externalId: f.key, nodeType: f.nodeType, title: f.title, content: f.content, metadata: f.metadata }));
  const result = await upsertNodes(db, run, input);
  for (const row of result.rows) ids[row.externalId] = row.id;
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC);

  // Written one at a time, oldest first, so updated_at strictly increases
  // (a single batch shares one now()).
  const main: Fixture[] = [
    { key: "r1", nodeType: TA, title: `alpha ${TOKEN}`, content: "first review", metadata: { project: P, labels: ["review"], status: "closed", closed_at: "2026-01-01T00:00:00.000Z" } },
    { key: "r2", nodeType: TA, title: "beta", content: `second review mentions ${TOKEN} in the body`, metadata: { project: P, labels: ["review", "x"], status: "open" } },
    { key: "n1", nodeType: TA, title: `gamma ${TOKEN}`, content: "not a review", metadata: { project: P, labels: ["x"], status: "open" } },
    { key: "n2", nodeType: TB, title: `delta ${TOKEN}`, content: "a review of type b", metadata: { project: P, labels: ["review"] } },
    { key: "q1", nodeType: TA, title: `epsilon ${TOKEN}`, content: "a review in q", metadata: { project: Q, labels: ["review"] } },
    { key: "np", nodeType: TB, title: `zeta ${TOKEN}`, content: "no project", metadata: {} },
    { key: "bare", nodeType: TA, title: `eta ${TOKEN}`, content: "labels is a bare string", metadata: { project: P, labels: "review" } },
    // Relevance: the body hit is newer, so only relevance puts the title hit first.
    { key: "rank-title", nodeType: TA, title: `${RANK} heading`, content: "unrelated words", metadata: {} },
    { key: "rank-body", nodeType: TA, title: "other heading", content: `words then ${RANK} later`, metadata: {} },
    { key: "tie-old", nodeType: TA, title: `${TIE} same`, content: "same", metadata: {} },
    { key: "tie-new", nodeType: TA, title: `${TIE} same`, content: "same", metadata: {} },
    { key: "merged-x", nodeType: TA, title: `${MERGED_ONLY} ${SHARED}`, content: "loser", metadata: {} },
    { key: "merged-y", nodeType: TA, title: `${SHARED}`, content: "survivor", metadata: {} },
  ];
  for (const f of main) await write([f]);
  // One batch: identical text and one shared updated_at, so only id breaks the tie.
  await write([
    { key: "tie-batch-1", nodeType: TA, title: `${TIE} same`, content: "same", metadata: {} },
    { key: "tie-batch-2", nodeType: TA, title: `${TIE} same`, content: "same", metadata: {} },
  ]);
  for (let i = 1; i <= 5; i += 1) {
    await write([{ key: `page-${i}`, nodeType: TB, title: `${PAGE} ${i}`, content: "page", metadata: {} }]);
  }

  const loser = ids["merged-x"];
  const survivor = ids["merged-y"];
  if (!loser || !survivor) throw new Error("merge fixtures missing");
  await mergeNodes(db, loser, survivor, run);
});

afterAll(async () => {
  await db.delete(nodes).where(inArray(nodes.sourceSystem, [SRC]));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
  await pool.end();
});

const keys = (found: FoundNode[]) => found.map((n) => n.externalId);
const facet = (list: { value: string; count: number }[], value: string) => list.find((f) => f.value === value)?.count;

describe("findNodes", () => {
  it("lists every review in a project with no text, newest first, and counts them", async () => {
    const result = await findNodes(db, { projects: [P], reviewsOnly: true });
    expect(keys(result.nodes)).toEqual(["n2", "r2", "r1"]);
    expect(result.total).toBe(3);
    expect(result.facets.reviews).toBe(3);
    expect(result.hasMore).toBe(false);
    const r1 = result.nodes.find((n) => n.externalId === "r1");
    expect(r1).toMatchObject({ project: P, status: "closed", closedAt: "2026-01-01T00:00:00.000Z", isReview: true, snippet: null, sourceSystem: SRC, nodeType: TA });
    expect(r1?.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(r1 ?? {}).sort()).toEqual(
      ["closedAt", "externalId", "id", "isReview", "nodeType", "project", "snippet", "sourceSystem", "status", "title", "updatedAt"].sort(),
    );
  });

  it("counts a project facet without its own filter, chosen value first", async () => {
    const result = await findNodes(db, { projects: [P] });
    expect(keys(result.nodes).sort()).toEqual(["bare", "n1", "n2", "r1", "r2"]);
    expect(result.facets.projects[0]).toEqual({ value: P, count: 5 });
    expect(result.facets.nodeTypes).toEqual([
      { value: TA, count: 4 },
      { value: TB, count: 1 },
    ]);
    expect(result.facets.reviews).toBe(3);
  });

  it("filters text by type while the type facet still counts every type", async () => {
    const result = await findNodes(db, { text: TOKEN, nodeTypes: [TB] });
    expect(keys(result.nodes).sort()).toEqual(["n2", "np"]);
    expect(result.total).toBe(2);
    expect(result.facets.nodeTypes).toEqual([
      { value: TB, count: 2 },
      { value: TA, count: 5 },
    ]);
  });

  it("counts each facet under every filter except its own", async () => {
    const result = await findNodes(db, { text: TOKEN, nodeTypes: [TA], projects: [P], reviewsOnly: true });
    expect(keys(result.nodes).sort()).toEqual(["r1", "r2"]);
    expect(result.total).toBe(2);
    expect(result.facets.nodeTypes).toEqual([
      { value: TA, count: 2 },
      { value: TB, count: 1 },
    ]);
    expect(result.facets.projects).toEqual([
      { value: P, count: 2 },
      { value: Q, count: 1 },
    ]);
    expect(result.facets.reviews).toBe(2);
  });

  it("passes nodes without a project only while no project is chosen", async () => {
    const open = await findNodes(db, { text: TOKEN });
    expect(keys(open.nodes)).toContain("np");
    expect(open.total).toBe(7);
    const chosen = await findNodes(db, { text: TOKEN, projects: [P, Q] });
    expect(keys(chosen.nodes)).not.toContain("np");
    expect(chosen.total).toBe(6);
    expect(chosen.facets.projects.map((f) => f.value)).toEqual([P, Q]);
  });

  it("leaves a chosen value with no matches out of its facet list", async () => {
    const noneType = `find-none-${SUFFIX}`;
    const noneProject = `find-none-${SUFFIX}`;
    const result = await findNodes(db, { text: TOKEN, nodeTypes: [TA, noneType], projects: [P, noneProject] });
    expect(facet(result.facets.nodeTypes, noneType)).toBeUndefined();
    expect(facet(result.facets.projects, noneProject)).toBeUndefined();
    expect(facet(result.facets.nodeTypes, TA)).toBe(4);
  });

  it("orders text results by relevance, then newest, then id", async () => {
    const ranked = await findNodes(db, { text: RANK });
    expect(keys(ranked.nodes)).toEqual(["rank-title", "rank-body"]);

    const tied = await findNodes(db, { text: TIE });
    const batch = [ids["tie-batch-1"], ids["tie-batch-2"]].sort().reverse();
    const batchKeys = batch.map((id) => tied.nodes.find((n) => n.id === id)?.externalId);
    expect(keys(tied.nodes)).toEqual([...batchKeys, "tie-new", "tie-old"]);
  });

  it("neither returns nor counts merged-away nodes", async () => {
    const loserOnly = await findNodes(db, { text: MERGED_ONLY });
    expect(loserOnly.nodes).toEqual([]);
    expect(loserOnly.total).toBe(0);
    expect(loserOnly.facets.nodeTypes).toEqual([]);

    const shared = await findNodes(db, { text: SHARED });
    expect(keys(shared.nodes)).toEqual(["merged-y"]);
    expect(shared.total).toBe(1);
    expect(shared.facets.nodeTypes).toEqual([{ value: TA, count: 1 }]);
  });

  it("pages by offset without repeating and covers every match", async () => {
    const all = await findNodes(db, { text: PAGE, limit: MAX_FIND_LIMIT });
    expect(all.nodes).toHaveLength(5);
    const seen: string[] = [];
    const more: boolean[] = [];
    for (const offset of [0, 2, 4]) {
      const page = await findNodes(db, { text: PAGE, limit: 2, offset });
      seen.push(...page.nodes.map((n) => n.id));
      more.push(page.hasMore);
      expect(page.total).toBe(5);
    }
    expect(more).toEqual([true, true, false]);
    expect(seen).toEqual(all.nodes.map((n) => n.id));
    expect(new Set(seen).size).toBe(5);
  });

  it("highlights a snippet with text and returns none without", async () => {
    const withText = await findNodes(db, { text: TOKEN, projects: [P] });
    expect(withText.nodes.length).toBeGreaterThan(0);
    for (const n of withText.nodes) expect(n.snippet).toMatch(/\[\[.+\]\]/);
    const withoutText = await findNodes(db, { projects: [P] });
    for (const n of withoutText.nodes) expect(n.snippet).toBeNull();
  });

  it("matches nothing for exclusion-only text", async () => {
    const result = await findNodes(db, { text: `-${TOKEN}`, nodeTypes: [TA, TB] });
    expect(result.nodes).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("refuses stopword-only text", async () => {
    await expect(findNodes(db, { text: "the of and" })).rejects.toBeInstanceOf(EmptyQueryError);
  });

  it("treats whitespace-only text as no text", async () => {
    const blank = await findNodes(db, { text: "   ", projects: [P] });
    const none = await findNodes(db, { projects: [P] });
    expect(blank.nodes.map((n) => n.id)).toEqual(none.nodes.map((n) => n.id));
    expect(blank.total).toBe(5);
  });

  it("rejects malformed options before any SQL runs", async () => {
    let executed = 0;
    const spy = { execute: async () => { executed += 1; return { rows: [] }; } } as unknown as Database;
    const names = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    const cases: FindNodesOptions[] = [
      { limit: 0 },
      { limit: MAX_FIND_LIMIT + 1 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: MAX_FIND_OFFSET + 1 },
      { text: "x".repeat(MAX_FIND_TEXT_LENGTH + 1) },
      { text: 42 as unknown as string },
      { nodeTypes: [] },
      { nodeTypes: names(MAX_LIST_NAMES + 1) },
      { nodeTypes: [""] },
      { projects: names(MAX_LIST_NAMES + 1) },
      { reviewsOnly: "yes" as unknown as boolean },
    ];
    for (const options of cases) {
      await expect(findNodes(spy, options)).rejects.toBeInstanceOf(InvalidListOptionError);
    }
    expect(executed).toBe(0);
  });

  it("buildFindNodesQuery parses and highlights only when there is text", () => {
    const dialect = new PgDialect();
    const params = { text: null, nodeTypes: null, projects: ["p'; DROP TABLE nodes; --"], reviewsOnly: false, limit: 10, offset: 0 };
    const noText = dialect.sqlToQuery(buildFindNodesQuery(params));
    expect(noText.sql).not.toContain("websearch_to_tsquery");
    expect(noText.sql).not.toContain("ts_headline");
    expect(noText.sql).not.toContain("DROP TABLE");
    const withText = dialect.sqlToQuery(buildFindNodesQuery({ ...params, text: "cuts" }));
    expect(withText.sql).toContain("websearch_to_tsquery");
    expect(withText.sql).toContain("ts_headline");
    expect(withText.params).toContain("cuts");
  });
});
