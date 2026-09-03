// Database tests for `loadGitRepoTree` (git-repo-ingestor change, task
// 1.4). Every fixture is scoped by a unique repository key — external ids
// all start with `<key>:` — so nothing here asserts on a global count or
// on `ingest_runs` rows (other suites write under other keys, and other
// source systems, in parallel against the same database).

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { unsafeBuildUpsertEdgesQuery } from "./edges.js";
import { EdgeUpsertFailedError } from "./errors.js";
import {
  buildRepoTree,
  DIRECTORY_NODE_TYPE,
  FILE_NODE_TYPE,
  GIT_SOURCE_SYSTEM,
  gitExternalId,
  loadGitRepoTree,
  type GitRepoTree,
  type LoadableFile,
} from "./git-repo.js";
import { REPO_NODE_TYPE } from "./github.js";
import { getIngestRunContents, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { listNodes, type ListNodesOptions, type ListedNode } from "./list.js";
import { getNeighbors, getNodes } from "./lookup.js";
import { retrieve } from "./retrieval.js";
import { asPgError } from "./sql-helpers.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

// Wrap (not replace) the edge query builder so one test can make the edge
// batch genuinely fail at the database — the query is built against an
// ingest run id that does not exist, a real 23503 on edges.ingest_run_id —
// after the node chunks have already executed inside the same transaction.
// The same shape human-writes.test.ts uses to wrap openIngestRun.
vi.mock("./edges.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./edges.js")>();
  return { ...actual, unsafeBuildUpsertEdgesQuery: vi.fn(actual.unsafeBuildUpsertEdgesQuery) };
});
const actualEdges = await vi.importActual<typeof import("./edges.js")>("./edges.js");

const PREFIX = `gri-test-${uniqueSuffix()}`;
const keyFor = (name: string): string => `${PREFIX}/${name}`;

let pool: TestPool;
let db: Database;
const openRuns: string[] = [];

async function newRun(actor: string): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, GIT_SOURCE_SYSTEM, { actor });
  openRuns.push(run.id);
  return run;
}

const SHA = (c: string): string => c.repeat(40);

/** A small checkout: two TypeScript files, a Markdown file, an HTML file, and a file with no language. */
function fixtureFiles(ident: string): LoadableFile[] {
  return [
    { path: "packages/core/src/route.ts", blobSha: SHA("1"), sizeBytes: 60, text: `export function ${ident}(): string {\n  return "graph";\n}\n` },
    { path: "packages/core/src/index.ts", blobSha: SHA("2"), sizeBytes: 30, text: `export { ${ident} } from "./route.js";\n` },
    { path: "README.md", blobSha: SHA("3"), sizeBytes: 20, text: "# Fixture\n\nA checkout.\n" },
    { path: "apps/web/index.html", blobSha: SHA("4"), sizeBytes: 15, text: "<html></html>\n" },
    { path: "Makefile", blobSha: SHA("5"), sizeBytes: 10, text: "all:\n\ttrue\n" },
  ];
}

async function nodeIdsUnder(key: string): Promise<string[]> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, GIT_SOURCE_SYSTEM), like(nodes.externalId, `${key}%`)));
  return rows.map((r) => r.id);
}

/** Pages through a whole listing — the store may hold many `git` file nodes from other keys, more than one page's worth. */
async function listAll(options: ListNodesOptions): Promise<ListedNode[]> {
  const out: ListedNode[] = [];
  let cursor: ListNodesOptions["cursor"] = null;
  for (;;) {
    const page = await listNodes(db, { ...options, limit: 500, cursor });
    out.push(...page.nodes);
    if (!page.hasMore || !page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, GIT_SOURCE_SYSTEM), like(nodes.externalId, `${PREFIX}%`)));
  for (const id of openRuns) await db.delete(ingestRuns).where(eq(ingestRuns.id, id));
  await pool.end();
});

describe("loadGitRepoTree", () => {
  it("writes the whole tree under one run, and a second run over the same checkout reports every node unchanged", async () => {
    const key = keyFor("twice");
    const tree = buildRepoTree(key, "/checkout/twice", fixtureFiles(`identTwice${uniqueSuffix()}`));

    const first = await newRun("git-repo-load-test");
    const firstResult = await loadGitRepoTree(db, first, tree);
    expect(firstResult.nodes).toMatchObject({ created: tree.nodes.length, updated: 0, unchanged: 0 });
    expect(firstResult.edges).toMatchObject({ created: tree.edges.length, updated: 0 });

    const attributed = await getIngestRunContents(db, first.id);
    expect(attributed.nodes).toHaveLength(tree.nodes.length);
    expect(attributed.edges).toHaveLength(tree.edges.length);
    expect(attributed.edges.every((e) => e.edgeType === CHILD_OF_EDGE_TYPE && e.sourceSystem === GIT_SOURCE_SYSTEM && e.weight === 1)).toBe(true);

    const second = await newRun("git-repo-load-test");
    const secondResult = await loadGitRepoTree(db, second, tree);
    expect(secondResult.nodes).toMatchObject({ created: 0, updated: 0, unchanged: tree.nodes.length });
    // Edges have no `unchanged` state in the write path: a re-asserted
    // edge is reported `updated` by upsertEdges. Nothing is created.
    expect(secondResult.edges).toMatchObject({ created: 0, updated: tree.edges.length });
    expect(new Set(secondResult.nodes.rows.map((r) => r.id))).toEqual(new Set(firstResult.nodes.rows.map((r) => r.id)));
  });

  it("reports only the edited file updated, with its blob_sha, size_bytes, and line_count reflecting the new text", async () => {
    const key = keyFor("edit");
    const files = fixtureFiles(`identEdit${uniqueSuffix()}`);
    await loadGitRepoTree(db, await newRun("git-repo-load-test"), buildRepoTree(key, "/checkout/edit", files));

    const edited: LoadableFile[] = files.map((f) =>
      f.path === "packages/core/src/route.ts" ? { ...f, blobSha: SHA("9"), sizeBytes: 99, text: `${f.text}\nexport const more = true;\n` } : f,
    );
    const result = await loadGitRepoTree(db, await newRun("git-repo-load-test"), buildRepoTree(key, "/checkout/edit", edited));
    expect(result.nodes).toMatchObject({ created: 0, updated: 1 });
    expect(result.nodes.unchanged).toBe(result.nodes.rows.length - 1);
    const updatedRow = result.nodes.rows.find((r) => r.action === "updated");
    expect(updatedRow?.externalId).toBe(gitExternalId(key, "packages/core/src/route.ts"));

    const { nodes: looked } = await getNodes(db, [updatedRow!.id]);
    expect(looked[0]?.metadata).toEqual({
      path: "packages/core/src/route.ts",
      size_bytes: 99,
      line_count: 5,
      blob_sha: SHA("9"),
      language: "typescript",
    });
    expect(looked[0]?.content).toContain("export const more = true;");
  });

  it("makes a loaded file findable by full-text search for an identifier inside it", async () => {
    const key = keyFor("search");
    const ident = `graphRouteFromSearch${uniqueSuffix()}`;
    const result = await loadGitRepoTree(db, await newRun("git-repo-load-test"), buildRepoTree(key, "/checkout/search", fixtureFiles(ident)));
    const routeId = result.nodes.rows.find((r) => r.externalId === gitExternalId(key, "packages/core/src/route.ts"))?.id;
    expect(routeId).toBeTruthy();

    const found = await retrieve(db, ident, { sourceSystems: [GIT_SOURCE_SYSTEM] });
    expect(found.mode).toBe("exact");
    const hit = found.nodes.find((n) => n.id === routeId);
    expect(hit).toBeDefined();
    expect(hit?.isSeed).toBe(true);
    expect(hit?.title).toBe("route.ts");
  });

  it("lets listNodes select files by language", async () => {
    const key = keyFor("list");
    await loadGitRepoTree(db, await newRun("git-repo-load-test"), buildRepoTree(key, "/checkout/list", fixtureFiles(`identList${uniqueSuffix()}`)));

    const typescript = (
      await listAll({
        nodeTypes: [FILE_NODE_TYPE],
        sourceSystems: [GIT_SOURCE_SYSTEM],
        where: [{ key: "language", op: "equals", value: "typescript" }],
      })
    ).filter((n) => n.externalId.startsWith(`${key}:`));
    expect(typescript.map((n) => n.externalId).sort()).toEqual([gitExternalId(key, "packages/core/src/index.ts"), gitExternalId(key, "packages/core/src/route.ts")]);
    expect(typescript.every((n) => n.metadata.language === "typescript")).toBe(true);

    const everything = (await listAll({ sourceSystems: [GIT_SOURCE_SYSTEM] })).filter((n) => n.externalId.startsWith(key));
    expect(everything.filter((n) => n.nodeType === FILE_NODE_TYPE)).toHaveLength(5);
    expect(everything.filter((n) => n.nodeType === DIRECTORY_NODE_TYPE).map((n) => n.metadata.path).sort()).toEqual(["apps", "apps/web", "packages", "packages/core", "packages/core/src"]);
    expect(everything.find((n) => n.nodeType === REPO_NODE_TYPE)?.metadata).toEqual({ key, root_path: "/checkout/list" });
  });

  it("walks child_of from a file up to the repo node through getNeighbors", async () => {
    const key = keyFor("walk");
    const result = await loadGitRepoTree(db, await newRun("git-repo-load-test"), buildRepoTree(key, "/checkout/walk", fixtureFiles(`identWalk${uniqueSuffix()}`)));
    const start = result.nodes.rows.find((r) => r.externalId === gitExternalId(key, "packages/core/src/route.ts"));
    expect(start).toBeDefined();

    const visited: string[] = [];
    let current = { id: start!.id, nodeType: FILE_NODE_TYPE };
    for (let hops = 0; current.nodeType !== REPO_NODE_TYPE; hops += 1) {
      expect(hops).toBeLessThan(10);
      const { neighbors } = await getNeighbors(db, current.id);
      const parents = neighbors.filter((n) => n.direction === "outgoing" && n.edgeType === CHILD_OF_EDGE_TYPE);
      expect(parents).toHaveLength(1);
      const parent = parents[0]!;
      expect(parent.edgeSourceSystem).toBe(GIT_SOURCE_SYSTEM);
      visited.push(parent.externalId);
      current = { id: parent.nodeId, nodeType: parent.nodeType };
    }
    expect(visited).toEqual([gitExternalId(key, "packages/core/src"), gitExternalId(key, "packages/core"), gitExternalId(key, "packages"), key]);

    // The repo node has no child_of edge of its own.
    const { neighbors: rootNeighbors } = await getNeighbors(db, current.id);
    expect(rootNeighbors.filter((n) => n.direction === "outgoing" && n.edgeType === CHILD_OF_EDGE_TYPE)).toHaveLength(0);
  });

  it("persists no node from a run whose edge batch fails", async () => {
    const key = keyFor("rollback");
    const tree: GitRepoTree = buildRepoTree(key, "/checkout/rollback", fixtureFiles(`identRollback${uniqueSuffix()}`));
    const run = await newRun("git-repo-load-test");

    // No ingest run has this id: the edge INSERT fails with a genuine
    // foreign-key violation after every node chunk has executed inside
    // the same transaction.
    vi.mocked(unsafeBuildUpsertEdgesQuery).mockImplementationOnce((rows) =>
      actualEdges.unsafeBuildUpsertEdgesQuery(rows, "00000000-0000-0000-0000-000000000000"),
    );

    let thrown: unknown;
    try {
      await loadGitRepoTree(db, run, tree);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EdgeUpsertFailedError);
    // The failure was the forced one — Postgres refusing the edge row's
    // ingest_run_id — not some other rejection along the way. The wrapper
    // keeps drizzle's query error as `cause`; `asPgError` reaches the pg
    // error inside it the same way the wrapper's own message does.
    expect(asPgError((thrown as EdgeUpsertFailedError).cause)).toMatchObject({ code: "23503", constraint: "edges_ingest_run_id_ingest_runs_id_fk" });

    expect(await nodeIdsUnder(key)).toEqual([]);
    const contents = await getIngestRunContents(db, run.id);
    expect(contents.nodes).toEqual([]);
    expect(contents.edges).toEqual([]);

    // The same tree loads cleanly once the edge batch can succeed.
    const retry = await loadGitRepoTree(db, await newRun("git-repo-load-test"), tree);
    expect(retry.nodes.created).toBe(tree.nodes.length);
    expect(retry.edges.created).toBe(tree.edges.length);
  });
});
