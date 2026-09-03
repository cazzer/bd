// Database tests for `getSubtree` (code-view change, task 1.2). Every
// fixture is a tree written through `loadGitRepoTree` under a unique
// repository key — every external id starts with `<key>:` — so nothing
// here asserts on a store-wide count or on `ingest_runs` rows (other
// suites write under other keys and source systems, concurrently, against
// the same database).
//
// Fixture names are all lowercase on purpose: the read orders by title,
// and a mixed-case listing sorts differently under the C and en_US
// collations, which is the database's setting, not this module's.

import { and, eq, like } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { InvalidLookupIdError, InvalidLookupOptionError, NodeNotFoundError } from "./errors.js";
import { buildRepoTree, DIRECTORY_NODE_TYPE, FILE_NODE_TYPE, GIT_SOURCE_SYSTEM, gitExternalId, loadGitRepoTree, type LoadableFile } from "./git-repo.js";
import { REPO_NODE_TYPE } from "./github.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";
import { buildGetSubtreeQuery, getSubtree, MAX_SUBTREE_DEPTH, MAX_SUBTREE_NODES, type SubtreeNode } from "./tree.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

const PREFIX = `tree-test-${uniqueSuffix()}`;
const keyFor = (name: string): string => `${PREFIX}/${name}`;
const NO_NODE_ID = "00000000-0000-4000-8000-000000000000";

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
const openRuns: string[] = [];

const SHA = (c: string): string => c.repeat(40);

/** Twelve nodes: the root, five directories, six files — two of them at depth four. */
function fixtureFiles(ident: string): LoadableFile[] {
  return [
    { path: "apps/web/index.html", blobSha: SHA("1"), sizeBytes: 15, text: "<html></html>\n" },
    { path: "apps/web/main.ts", blobSha: SHA("2"), sizeBytes: 20, text: `export const ${ident} = 1;\n` },
    { path: "packages/core/src/index.ts", blobSha: SHA("3"), sizeBytes: 30, text: `export { ${ident} } from "./route.js";\n` },
    { path: "packages/core/src/route.ts", blobSha: SHA("4"), sizeBytes: 60, text: `export function ${ident}(): string {\n  return "code";\n}\n` },
    { path: "readme.md", blobSha: SHA("5"), sizeBytes: 20, text: "# Fixture\n\nA checkout.\n" },
    { path: "makefile", blobSha: SHA("6"), sizeBytes: 10, text: "all:\n\ttrue\n" },
  ];
}

/** The fixture's paths in the order the read returns them: depth, then title (`""` is the root). */
const EXPECTED_ORDER: readonly string[] = [
  "",
  "apps",
  "makefile",
  "packages",
  "readme.md",
  "packages/core",
  "apps/web",
  "apps/web/index.html",
  "apps/web/main.ts",
  "packages/core/src",
  "packages/core/src/index.ts",
  "packages/core/src/route.ts",
];

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Loads the fixture under `key` and returns the node id of every path (`""` for the root). */
async function loadFixture(key: string): Promise<Map<string, string>> {
  const tree = buildRepoTree(key, `/checkout/${key}`, fixtureFiles(`ident${uniqueSuffix()}`));
  const result = await loadGitRepoTree(db, run, tree);
  const ids = new Map<string, string>();
  for (const row of result.nodes.rows) {
    const path = row.externalId === key ? "" : row.externalId.slice(key.length + 1);
    ids.set(path, row.id);
  }
  expect(ids.size).toBe(12);
  return ids;
}

const byId = (rows: readonly SubtreeNode[]): Map<string, SubtreeNode> => new Map(rows.map((r) => [r.id, r]));

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, GIT_SOURCE_SYSTEM, { actor: "tree-test" });
  openRuns.push(run.id);
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, GIT_SOURCE_SYSTEM), like(nodes.externalId, `${PREFIX}%`)));
  for (const id of openRuns) await db.delete(ingestRuns).where(eq(ingestRuns.id, id));
  await pool.end();
});

describe("getSubtree", () => {
  it("returns every directory and file with its parent, the root as the one parentless row, ordered by depth then title", async () => {
    const key = keyFor("basic");
    const ids = await loadFixture(key);
    const rootId = ids.get("")!;

    const subtree = await getSubtree(db, rootId);
    expect(subtree.rootId).toBe(rootId);
    expect(subtree.truncated).toBe(false);
    expect(subtree.nodes.map((n) => n.externalId)).toEqual(EXPECTED_ORDER.map((p) => gitExternalId(key, p || undefined)));

    const root = subtree.nodes[0]!;
    expect(root).toEqual({ id: rootId, parentId: null, nodeType: REPO_NODE_TYPE, title: key, externalId: key, path: null, language: null });
    expect(subtree.nodes.filter((n) => n.parentId === null)).toHaveLength(1);

    for (const path of EXPECTED_ORDER.slice(1)) {
      const row = subtree.nodes.find((n) => n.id === ids.get(path));
      expect(row, path).toBeDefined();
      expect(row!.parentId, path).toBe(ids.get(parentPath(path)));
      expect(row!.path, path).toBe(path);
      expect(row!.title, path).toBe(path.slice(path.lastIndexOf("/") + 1));
    }

    const routeTs = subtree.nodes.find((n) => n.id === ids.get("packages/core/src/route.ts"))!;
    expect(routeTs.nodeType).toBe(FILE_NODE_TYPE);
    expect(routeTs.language).toBe("typescript");
    const src = subtree.nodes.find((n) => n.id === ids.get("packages/core/src"))!;
    expect(src.nodeType).toBe(DIRECTORY_NODE_TYPE);
    expect(src.language).toBeNull();

    // Structure only — the file pane reads content by getNodes.
    for (const row of subtree.nodes) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("metadata");
    }
  });

  it("answers a single row for a leaf root", async () => {
    const key = keyFor("leaf");
    const ids = await loadFixture(key);
    const fileId = ids.get("readme.md")!;

    const subtree = await getSubtree(db, fileId);
    expect(subtree.truncated).toBe(false);
    expect(subtree.nodes).toHaveLength(1);
    expect(subtree.nodes[0]).toMatchObject({ id: fileId, parentId: null, path: "readme.md", language: "markdown" });
  });

  it("folds a merged-away directory's children onto its survivor, omits the loser, and answers the survivor's subtree for the loser's id", async () => {
    const key = keyFor("merge");
    const ids = await loadFixture(key);
    const rootId = ids.get("")!;
    const packagesId = ids.get("packages")!;
    const coreId = ids.get("packages/core")!;

    // A duplicate of packages/core beside it, with one file of its own.
    const written = await upsertNodes(db, run, [
      { nodeType: DIRECTORY_NODE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, externalId: gitExternalId(key, "packages/core-dup"), title: "core-dup", content: "extra.ts", metadata: { path: "packages/core-dup" } },
      { nodeType: FILE_NODE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, externalId: gitExternalId(key, "packages/core-dup/extra.ts"), title: "extra.ts", content: "export {};\n", metadata: { path: "packages/core-dup/extra.ts", language: "typescript" } },
    ]);
    const dupId = written.rows.find((r) => r.externalId === gitExternalId(key, "packages/core-dup"))!.id;
    const extraId = written.rows.find((r) => r.externalId === gitExternalId(key, "packages/core-dup/extra.ts"))!.id;
    await upsertEdges(db, run, [
      { srcId: dupId, dstId: packagesId, edgeType: CHILD_OF_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM },
      { srcId: extraId, dstId: dupId, edgeType: CHILD_OF_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM },
    ]);

    const before = byId((await getSubtree(db, rootId)).nodes);
    expect(before.size).toBe(14);
    expect(before.get(dupId)?.parentId).toBe(packagesId);
    expect(before.get(extraId)?.parentId).toBe(dupId);

    await mergeNodes(db, dupId, coreId, run);

    const after = await getSubtree(db, rootId);
    const rows = byId(after.nodes);
    expect(after.nodes).toHaveLength(13);
    expect(rows.size).toBe(13); // each node once
    expect(rows.has(dupId)).toBe(false);
    expect(rows.get(extraId)?.parentId).toBe(coreId);
    expect(rows.get(coreId)?.parentId).toBe(packagesId);
    expect(rows.get(ids.get("packages/core/src")!)?.parentId).toBe(coreId);
    // extra.ts is a depth-3 sibling of src now, and titles order them.
    const depth3 = after.nodes.slice(7, 11).map((n) => n.title);
    expect(depth3).toEqual(["extra.ts", "index.html", "main.ts", "src"]);

    const viaLoser = await getSubtree(db, dupId);
    expect(viaLoser.rootId).toBe(coreId);
    expect(viaLoser.nodes[0]).toMatchObject({ id: coreId, parentId: null });
    expect(viaLoser.nodes.map((n) => n.title)).toEqual(["core", "extra.ts", "src", "index.ts", "route.ts"]);
    expect(viaLoser.nodes.find((n) => n.id === extraId)?.parentId).toBe(coreId);
  });

  it("terminates on a two-node child_of cycle below the root, placing each node once at its least depth", async () => {
    const key = keyFor("cycle");
    const ids = await loadFixture(key);
    const rootId = ids.get("")!;
    const coreId = ids.get("packages/core")!;
    const srcId = ids.get("packages/core/src")!;

    // src is already child_of core; now core is child_of src too.
    await upsertEdges(db, run, [{ srcId: coreId, dstId: srcId, edgeType: CHILD_OF_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM }]);

    const subtree = await getSubtree(db, rootId);
    expect(subtree.truncated).toBe(false);
    expect(subtree.nodes).toHaveLength(12);
    const rows = byId(subtree.nodes);
    expect(rows.size).toBe(12);
    expect(new Set(rows.keys())).toEqual(new Set(ids.values()));
    expect(rows.get(coreId)?.parentId).toBe(ids.get("packages"));
    expect(rows.get(srcId)?.parentId).toBe(coreId);
    expect(rows.get(ids.get("packages/core/src/route.ts")!)?.parentId).toBe(srcId);
    // Least depth is where each is placed, so the order is the tree's own.
    expect(subtree.nodes.map((n) => n.externalId)).toEqual(EXPECTED_ORDER.map((p) => gitExternalId(key, p || undefined)));
  });

  it("stops at the depth bound", async () => {
    const key = keyFor("depth");
    const ids = await loadFixture(key);
    const rootId = ids.get("")!;

    const shallow = await getSubtree(db, rootId, { maxDepth: 2 });
    expect(shallow.nodes.map((n) => n.externalId)).toEqual(EXPECTED_ORDER.slice(0, 7).map((p) => gitExternalId(key, p || undefined)));
    // The depth cap is a bound on the walk, not the node bound the flag reports.
    expect(shallow.truncated).toBe(false);

    const rootOnly = await getSubtree(db, rootId, { maxDepth: 0 });
    expect(rootOnly.nodes.map((n) => n.id)).toEqual([rootId]);
  });

  it("answers truncated: true with the shallowest rows when the tree exceeds a lowered node bound, and false at exactly the bound", async () => {
    const key = keyFor("bound");
    const ids = await loadFixture(key);
    const rootId = ids.get("")!;

    const cut = await getSubtree(db, rootId, { maxNodes: 3 });
    expect(cut.truncated).toBe(true);
    expect(cut.nodes.map((n) => n.externalId)).toEqual([key, gitExternalId(key, "apps"), gitExternalId(key, "makefile")]);
    expect(cut.nodes.every((n) => n.parentId === null || n.parentId === rootId)).toBe(true);

    const cutAtDepthBoundary = await getSubtree(db, rootId, { maxNodes: 11 });
    expect(cutAtDepthBoundary.truncated).toBe(true);
    expect(cutAtDepthBoundary.nodes).toHaveLength(11);
    expect(cutAtDepthBoundary.nodes.map((n) => n.externalId)).toEqual(EXPECTED_ORDER.slice(0, 11).map((p) => gitExternalId(key, p || undefined)));

    const exact = await getSubtree(db, rootId, { maxNodes: 12 });
    expect(exact.truncated).toBe(false);
    expect(exact.nodes).toHaveLength(12);
  });

  it("throws NodeNotFoundError for a well-formed id that names no node", async () => {
    await expect(getSubtree(db, NO_NODE_ID)).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("rejects a malformed id and an out-of-range bound before any SQL runs", async () => {
    let executed = 0;
    const spy = {
      execute: async () => {
        executed += 1;
        return { rows: [] };
      },
    } as unknown as Database;
    await expect(getSubtree(spy, "not-a-uuid")).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getSubtree(spy, "")).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getSubtree(spy, NO_NODE_ID, { maxNodes: 0 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getSubtree(spy, NO_NODE_ID, { maxNodes: MAX_SUBTREE_NODES + 1 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getSubtree(spy, NO_NODE_ID, { maxNodes: 1.5 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getSubtree(spy, NO_NODE_ID, { maxDepth: -1 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getSubtree(spy, NO_NODE_ID, { maxDepth: MAX_SUBTREE_DEPTH + 1 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    expect(executed).toBe(0);
  });

  it("buildGetSubtreeQuery is pure and binds the bounds as parameters", () => {
    const dialect = new PgDialect();
    const a = dialect.sqlToQuery(buildGetSubtreeQuery(NO_NODE_ID));
    const b = dialect.sqlToQuery(buildGetSubtreeQuery(NO_NODE_ID));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
    expect(a.params).toContain(MAX_SUBTREE_NODES + 1);
    expect(a.params).toContain(MAX_SUBTREE_DEPTH);
    const lowered = dialect.sqlToQuery(buildGetSubtreeQuery(NO_NODE_ID, { maxNodes: 3, maxDepth: 2 }));
    expect(lowered.sql).toBe(a.sql);
    expect(lowered.params).toContain(4);
    expect(lowered.params).toContain(2);
  });
});
