// Database tests for `loadGitRepoTree` (git-repo-ingestor change, task
// 1.4; commits in github-prs-and-commits task 2.2). Every fixture is scoped
// by a unique repository key — external ids all start with `<key>:` or
// `<key>@` — so nothing here asserts on a global count or on `ingest_runs`
// rows (other suites write under other keys, and other source systems, in
// parallel against the same database). The commit tests run against a real
// repository built with `git init` in a temp directory — the first test in
// this repository that runs git — so `parseGitLog` reads what git actually
// prints, not a transcription of it.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { unsafeBuildUpsertEdgesQuery } from "./edges.js";
import { EdgeUpsertFailedError } from "./errors.js";
import {
  buildRepoTree,
  COMMIT_NODE_TYPE,
  commitExternalId,
  DIRECTORY_NODE_TYPE,
  emptyCommitEdgeCounts,
  FILE_NODE_TYPE,
  GIT_LOG_FORMAT,
  GIT_SOURCE_SYSTEM,
  gitExternalId,
  isRepoSlug,
  loadGitRepoTree,
  parseGitLog,
  parseLsFiles,
  readWorkingTree,
  type GitCommit,
  type GitRepoTree,
  type LoadableFile,
  type LoadGitRepoTreeResult,
} from "./git-repo.js";
import { GITHUB_SOURCE_SYSTEM, ISSUE_NODE_TYPE, REPO_NODE_TYPE } from "./github.js";
import { getIngestRunContents, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { listNodes, type ListNodesOptions, type ListedNode } from "./list.js";
import { getNeighbors, getNodes, getNodesByExternalId } from "./lookup.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
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

async function newRun(actor: string, sourceSystem: string = GIT_SOURCE_SYSTEM): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, sourceSystem, { actor });
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
  // One statement over both source systems: the commit tests merge a git
  // root into a `github` fixture node, and a row's `merged_into` must go
  // with the row it points at.
  await db.delete(nodes).where(and(inArray(nodes.sourceSystem, [GIT_SOURCE_SYSTEM, GITHUB_SOURCE_SYSTEM]), like(nodes.externalId, `${PREFIX}%`)));
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

// --- Commits (github-prs-and-commits task 2.2) ----------------------------

const execFileAsync = promisify(execFile);

/** The variables a suite run from a git hook inherits that would point git at the hook's repository instead of the fixture. */
const GIT_REDIRECT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"];

/**
 * Runs `git <args>` in `cwd` with the user's global and system config
 * masked, so a signing key, a hooks path, or a commit template on the
 * machine cannot reach the fixture, and with `GIT_REDIRECT_VARIABLES`
 * removed, so a suite run from a hook cannot be pointed away from it;
 * identity is set locally below. `env` adds to that — the pinned dates a
 * commit is made under.
 */
async function gitIn(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const inherited: Record<string, string | undefined> = { ...process.env };
  for (const name of GIT_REDIRECT_VARIABLES) delete inherited[name];
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...inherited, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return stdout;
}

/** Author and committer dates the fixture's two commits are made under, so a commit's `occurred_at` is asserted exactly rather than derived from what git printed. */
const FIXTURE_COMMIT_DATES = { first: "2026-09-01T10:00:00+02:00", second: "2026-09-02T12:30:00-04:00" } as const;
/** `FIXTURE_COMMIT_DATES.second` in the canonical form. */
const FIXTURE_SECOND_OCCURRED_AT = "2026-09-02T16:30:00.000Z";

function pinnedDates(instant: string): Record<string, string> {
  return { GIT_AUTHOR_DATE: instant, GIT_COMMITTER_DATE: instant };
}

/**
 * A real repository with two commits. The first adds `src/a.ts`,
 * `src/b.ts`, `README.md`, and `gone.txt`; the second changes both
 * TypeScript files, deletes `gone.txt`, and carries a message naming
 * `#12` (loaded as a `github` fixture issue under the same slug), `#999`
 * (loaded nowhere), and a `#12` inside a code span (not a reference).
 * Each is made under its `FIXTURE_COMMIT_DATES` instant.
 */
async function createFixtureRepo(ident: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gri-commits-"));
  await gitIn(root, ["init", "-q", "-b", "main"]);
  await gitIn(root, ["config", "user.name", "Fixture Author"]);
  await gitIn(root, ["config", "user.email", "fixture@example.invalid"]);
  await gitIn(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), `export const a = "${ident}";\n`);
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "gone.txt"), "soon deleted\n");
  await gitIn(root, ["add", "-A"]);
  await gitIn(root, ["commit", "-q", "-m", "Initial import"], pinnedDates(FIXTURE_COMMIT_DATES.first));
  await writeFile(join(root, "src/a.ts"), `export const a = "${ident}";\nexport const more = true;\n`);
  await writeFile(join(root, "src/b.ts"), "export const b = 3;\n");
  await rm(join(root, "gone.txt"));
  await gitIn(root, ["add", "-A"]);
  await gitIn(root, ["commit", "-q", "-m", "Touch a and b, drop gone.txt", "-m", "Closes #12; see also #999 and `#12` in code."], pinnedDates(FIXTURE_COMMIT_DATES.second));
  return root;
}

interface FixtureLoad {
  tree: GitRepoTree;
  commits: GitCommit[];
  result: LoadGitRepoTreeResult;
}

/** The script's pipeline over the fixture: `git ls-files`, the working-tree read, the tree, `git log` as ingest-git-repo.ts runs it, one load. */
async function loadFixture(key: string, root: string, run: IngestRunHandle, commitLimit = 500): Promise<FixtureLoad> {
  const { files } = await readWorkingTree(root, parseLsFiles(await gitIn(root, ["ls-files", "-s", "-z"])));
  const tree = buildRepoTree(key, root, files);
  const commits = parseGitLog(
    await gitIn(root, ["-c", "core.quotePath=false", "log", "--no-show-signature", "-n", String(commitLimit), "--name-only", `--format=${GIT_LOG_FORMAT}`]),
  );
  const result = await loadGitRepoTree(db, run, tree, { commits });
  return { tree, commits, result };
}

/** Writes the `github` side of a slug: its `repo` node and issue `#12`, as `pnpm ingest:github` would have. Returns their ids by external id. */
async function writeGithubFixture(slug: string): Promise<Map<string, string>> {
  const run = await newRun("git-repo-load-test-github", GITHUB_SOURCE_SYSTEM);
  const written = await upsertNodes(db, run, [
    { nodeType: REPO_NODE_TYPE, sourceSystem: GITHUB_SOURCE_SYSTEM, externalId: slug, title: slug, content: "A fixture repository." },
    { nodeType: ISSUE_NODE_TYPE, sourceSystem: GITHUB_SOURCE_SYSTEM, externalId: `${slug}#12`, title: "Fixture issue twelve", content: "" },
  ]);
  return new Map(written.rows.map((r) => [r.externalId, r.id]));
}

const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("loadGitRepoTree with commits", () => {
  let root: string;

  beforeAll(async () => {
    root = await createFixtureRepo(`identCommits${uniqueSuffix()}`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes commit nodes at the committer instant with belongs-to, touches to surviving files, mentions to the loaded issue, and counts the rest", async () => {
    const key = keyFor("commits");
    expect(isRepoSlug(key)).toBe(true);
    const github = await writeGithubFixture(key);

    const run = await newRun("git-repo-load-test");
    const { tree, commits, result } = await loadFixture(key, root, run);
    expect(commits).toHaveLength(2);
    const [newest, oldest] = commits as [GitCommit, GitCommit];
    expect(newest.parents).toEqual([oldest.sha]);
    expect(oldest.parents).toEqual([]);
    expect(newest.paths).toEqual(["gone.txt", "src/a.ts", "src/b.ts"]);
    expect(oldest.paths).toEqual(["README.md", "gone.txt", "src/a.ts", "src/b.ts"]);

    // The first commit touches its three surviving files; the second the
    // two it changed; `gone.txt` is skipped in both. `#12` resolves,
    // `#999` does not, the `#12` in code is no reference at all.
    expect(result.nodes).toMatchObject({ created: tree.nodes.length + 2, updated: 0, unchanged: 0 });
    expect(result.commits).toEqual({ loaded: 2, touches: 5, skippedPaths: 2, mentions: 1, unresolvedReferences: 1 });
    expect(result.edges).toMatchObject({ created: tree.edges.length + 2 + 5 + 1, updated: 0 });

    const idOf = (externalId: string): string => {
      const row = result.nodes.rows.find((r) => r.externalId === externalId);
      expect(row, externalId).toBeDefined();
      return row!.id;
    };
    const newestId = idOf(commitExternalId(key, newest.sha));
    const { nodes: looked } = await getNodes(db, [newestId]);
    expect(looked[0]).toMatchObject({
      nodeType: COMMIT_NODE_TYPE,
      sourceSystem: GIT_SOURCE_SYSTEM,
      title: "Touch a and b, drop gone.txt",
      content: "Touch a and b, drop gone.txt\n\nCloses #12; see also #999 and `#12` in code.",
    });
    // Made under a pinned `-04:00` instant: git prints `%cI` with that
    // zone, and the node sits at the same instant in the canonical form.
    expect(newest.committedAt).toBe(FIXTURE_COMMIT_DATES.second);
    expect(looked[0]?.metadata).toEqual({
      sha: newest.sha,
      parents: [oldest.sha],
      author: "Fixture Author",
      authored_at: FIXTURE_COMMIT_DATES.second,
      committed_at: FIXTURE_COMMIT_DATES.second,
      files_changed: 3,
      occurred_at: FIXTURE_SECOND_OCCURRED_AT,
    });
    expect(looked[0]?.metadata["occurred_at"]).toMatch(CANONICAL_INSTANT_RE);

    const { neighbors: fromNewest } = await getNeighbors(db, newestId);
    const outgoing = fromNewest.filter((n) => n.direction === "outgoing");
    expect(outgoing.map((n) => [n.edgeType, n.externalId, n.edgeSourceSystem]).sort()).toEqual(
      [
        ["belongs-to", key, GIT_SOURCE_SYSTEM],
        ["mentions", `${key}#12`, GIT_SOURCE_SYSTEM],
        ["touches", gitExternalId(key, "src/a.ts"), GIT_SOURCE_SYSTEM],
        ["touches", gitExternalId(key, "src/b.ts"), GIT_SOURCE_SYSTEM],
      ].sort(),
    );
    // `edges.weight` is a `real`: 0.8 reads back as the nearest float4.
    for (const n of outgoing) expect(n.weight, n.edgeType).toBeCloseTo(n.edgeType === "belongs-to" ? 1 : 0.8, 6);
    expect(outgoing.find((n) => n.edgeType === "mentions")).toMatchObject({ nodeId: github.get(`${key}#12`), nodeType: ISSUE_NODE_TYPE, nodeSourceSystem: GITHUB_SOURCE_SYSTEM });
    expect(outgoing.find((n) => n.edgeType === "belongs-to")).toMatchObject({ nodeId: idOf(key), nodeType: REPO_NODE_TYPE });

    const { neighbors: fromOldest } = await getNeighbors(db, idOf(commitExternalId(key, oldest.sha)));
    expect(
      fromOldest
        .filter((n) => n.direction === "outgoing")
        .map((n) => [n.edgeType, n.externalId])
        .sort(),
    ).toEqual([
      ["belongs-to", key],
      ["touches", gitExternalId(key, "README.md")],
      ["touches", gitExternalId(key, "src/a.ts")],
      ["touches", gitExternalId(key, "src/b.ts")],
    ]);

    // A file's side: its commits, as `touches`, and nothing from `gone.txt`, which has no node.
    const { neighbors: fromFile } = await getNeighbors(db, idOf(gitExternalId(key, "src/b.ts")));
    expect(fromFile.filter((n) => n.edgeType === "touches").map((n) => n.nodeType)).toEqual([COMMIT_NODE_TYPE, COMMIT_NODE_TYPE]);
    expect(result.nodes.rows.some((r) => r.externalId === gitExternalId(key, "gone.txt"))).toBe(false);

    const attributed = await getIngestRunContents(db, run.id);
    expect(attributed.nodes).toHaveLength(tree.nodes.length + 2);
    expect(attributed.edges).toHaveLength(tree.edges.length + 8);

    // Second run over the unchanged checkout: every node, commits
    // included, unchanged; edges re-asserted (`updated`, as upsertEdges
    // reports a re-assertion); the same counts.
    const second = await loadFixture(key, root, await newRun("git-repo-load-test"));
    expect(second.result.nodes).toMatchObject({ created: 0, updated: 0, unchanged: tree.nodes.length + 2 });
    expect(second.result.commits).toEqual(result.commits);
    expect(second.result.edges).toMatchObject({ created: 0, updated: tree.edges.length + 8 });
    expect(new Set(second.result.nodes.rows.map((r) => r.id))).toEqual(new Set(result.nodes.rows.map((r) => r.id)));
  });

  it("counts every reference unresolved under a key that is not a slug, and still loads", async () => {
    const key = `${PREFIX}-bd`;
    expect(isRepoSlug(key)).toBe(false);
    const run = await newRun("git-repo-load-test");
    const { tree, result } = await loadFixture(key, root, run);
    expect(result.nodes).toMatchObject({ created: tree.nodes.length + 2 });
    expect(result.commits).toEqual({ loaded: 2, touches: 5, skippedPaths: 2, mentions: 0, unresolvedReferences: 2 });
    const attributed = await getIngestRunContents(db, run.id);
    expect(attributed.edges.some((e) => e.edgeType === "mentions")).toBe(false);
    expect(attributed.edges.filter((e) => e.edgeType === "belongs-to")).toHaveLength(2);
  });

  it("loads the newest N alone, and a later, larger N adds the rest and reports the first unchanged", async () => {
    const key = keyFor("bound");
    const first = await loadFixture(key, root, await newRun("git-repo-load-test"), 1);
    expect(first.commits).toHaveLength(1);
    expect(first.result.nodes).toMatchObject({ created: first.tree.nodes.length + 1 });
    expect(first.result.commits).toEqual({ loaded: 1, touches: 2, skippedPaths: 1, mentions: 0, unresolvedReferences: 2 });

    const second = await loadFixture(key, root, await newRun("git-repo-load-test"), 2);
    expect(second.commits).toHaveLength(2);
    expect(second.commits[0]).toEqual(first.commits[0]);
    expect(second.result.nodes).toMatchObject({ created: 1, updated: 0, unchanged: first.tree.nodes.length + 1 });
    expect(second.result.nodes.rows.find((r) => r.action === "created")?.externalId).toBe(commitExternalId(key, second.commits[1]!.sha));
    expect(second.result.commits.loaded).toBe(2);
  });

  it("writes the tree exactly as before with commits: [] or no option at all", async () => {
    const key = keyFor("no-commits");
    const tree = buildRepoTree(key, "/checkout/no-commits", fixtureFiles(`identNoCommits${uniqueSuffix()}`));

    const explicit = await loadGitRepoTree(db, await newRun("git-repo-load-test"), tree, { commits: [] });
    expect(explicit.nodes).toMatchObject({ created: tree.nodes.length, updated: 0, unchanged: 0 });
    expect(explicit.edges).toMatchObject({ created: tree.edges.length, updated: 0 });
    expect(explicit.commits).toEqual(emptyCommitEdgeCounts());

    const absent = await loadGitRepoTree(db, await newRun("git-repo-load-test"), tree);
    expect(absent.nodes).toMatchObject({ created: 0, updated: 0, unchanged: tree.nodes.length });
    expect(absent.commits).toEqual(emptyCommitEdgeCounts());

    const commitRows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.sourceSystem, GIT_SOURCE_SYSTEM), like(nodes.externalId, `${key}@%`)));
    expect(commitRows).toEqual([]);
  });

  it("keeps a root's merged_into across a re-load once it has been merged into the GitHub repository node", async () => {
    const key = keyFor("merged");
    const github = await writeGithubFixture(key);
    const survivorId = github.get(key)!;

    const first = await loadFixture(key, root, await newRun("git-repo-load-test"));
    const rootId = first.result.nodes.rows.find((r) => r.externalId === key)!.id;
    const merge = await mergeNodes(db, rootId, survivorId, await newRun("git-repo-load-test-merge"));
    expect(merge).toEqual({ survivorId, mergedNodeIds: [rootId] });

    // The upsert never sets `merged_into`: the loser row is re-upserted
    // by external id, reports unchanged, and still points at the survivor.
    const again = await loadFixture(key, root, await newRun("git-repo-load-test"));
    expect(again.result.nodes.rows.find((r) => r.externalId === key)).toMatchObject({ id: rootId, action: "unchanged" });
    expect(again.result.commits).toEqual(first.result.commits);
    const [rootRow] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, rootId));
    expect(rootRow?.mergedInto).toBe(survivorId);

    // Every read folds: the identity lookup answers the survivor, and a
    // commit's `belongs-to` — still an edge to the loser's id, since
    // mergeNodes rewrites pointers, not edges — reads as the survivor.
    const lookup = await getNodesByExternalId(db, [{ sourceSystem: GIT_SOURCE_SYSTEM, externalId: key }]);
    expect(lookup.found).toEqual([{ sourceSystem: GIT_SOURCE_SYSTEM, externalId: key, id: survivorId, nodeType: REPO_NODE_TYPE }]);
    const commitId = again.result.nodes.rows.find((r) => r.externalId === commitExternalId(key, again.commits[0]!.sha))!.id;
    const { neighbors } = await getNeighbors(db, commitId);
    expect(neighbors.find((n) => n.edgeType === "belongs-to")).toMatchObject({ nodeId: survivorId, nodeSourceSystem: GITHUB_SOURCE_SYSTEM, externalId: key });
  });
});
