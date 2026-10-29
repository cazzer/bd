// DB-backed tests for `ingestBeadsCheckout` (live-beads-board, task 1.5) with
// a fixture runner, so no `bd` binary is involved. The loader's source
// system is fixed ('beads'), so isolation comes from a unique bead-id
// prefix and unique project keys per suite; teardown deletes exactly what
// the suite wrote. No assertion reads a store-wide count.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { type BeadsIssue } from "./beads.js";
import { ingestBeadsCheckout, type IngestBeadsCheckoutResult, type RunBd } from "./beads-ingest.js";
import { BeadsProjectConflictError, InvalidWorkItemError } from "./errors.js";
import { upsertEdges } from "./edges.js";
import { openIngestRun } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

// Wrap (not replace) openIngestRun so refusal tests can assert that no run
// was opened by counting calls, the human-writes.test.ts pattern.
vi.mock("./ingest-runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ingest-runs.js")>();
  return { ...actual, openIngestRun: vi.fn(actual.openIngestRun) };
});

function openIngestRunCalls(): number {
  return vi.mocked(openIngestRun).mock.calls.length;
}

const SUFFIX = uniqueSuffix().slice(0, 12);
const PREFIX = `bi${SUFFIX}`;
const keyOf = (name: string) => `${name}-${SUFFIX}`;
const SCRATCH = mkdtempSync(path.join(tmpdir(), "beads-ingest-test-"));
// realpath'd up front: on macOS the tmpdir itself is behind a symlink.
const ROOT = realpathSync(SCRATCH);
const DIR_A = path.join(ROOT, "a");
const DIR_B = path.join(ROOT, "b");
mkdirSync(DIR_A);
mkdirSync(DIR_B);

let pool: TestPool;
let db: Database;
const runIds: string[] = [];

function issue(n: number, overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id: `${PREFIX}-${n}`,
    title: `Issue ${n}`,
    description: `desc ${n}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function fixture(issues: BeadsIssue[]): RunBd {
  return async (args) => {
    expect(args).toEqual(["list", "--status=all", "--limit=0", "--json"]);
    return JSON.stringify(issues);
  };
}

async function load(issues: BeadsIssue[], opts: { dir?: string; project?: string }): Promise<IngestBeadsCheckoutResult> {
  const result = await ingestBeadsCheckout(db, { dir: opts.dir ?? DIR_A, ...(opts.project === undefined ? {} : { project: opts.project }), runBd: fixture(issues) });
  runIds.push(result.ingestRunId);
  return result;
}

async function rowsOf(externalIds: string[]) {
  return db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, externalIds)));
}

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), or(like(nodes.externalId, `${PREFIX}-%`), like(nodes.externalId, `project:%-${SUFFIX}`))));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("ingestBeadsCheckout", () => {
  it("creates items with project and a registry node; a re-load is all unchanged; a changed fixture reports exactly the changed ids", async () => {
    const project = keyOf("main");
    const issues = [issue(1), issue(2, { dependencies: [{ issue_id: `${PREFIX}-2`, depends_on_id: `${PREFIX}-1`, type: "blocks" }] }), issue(3)];

    const first = await load(issues, { project });
    expect(first).toMatchObject({ project, path: DIR_A, nodes: { created: 4, updated: 0, unchanged: 0 }, edges: { created: 1, updated: 0 } });
    expect(first.changedNodeIds).toHaveLength(4);

    const items = await rowsOf([1, 2, 3].map((n) => `${PREFIX}-${n}`));
    expect(items).toHaveLength(3);
    for (const row of items) {
      expect(row.nodeType).toBe("work_item");
      expect(row.metadata).toMatchObject({ project });
    }
    const [registry] = await rowsOf([`project:${project}`]);
    expect(registry).toMatchObject({ nodeType: "beads_project", title: project, metadata: { project, path: DIR_A } });
    const [run] = await db.select().from(ingestRuns).where(eq(ingestRuns.id, first.ingestRunId));
    expect(run).toMatchObject({ sourceSystem: "beads", actor: "ingest:beads" });

    const second = await load(issues, { project });
    expect(second.nodes).toEqual({ created: 0, updated: 0, unchanged: 4 });
    expect(second.changedNodeIds).toEqual([]);
    expect(second.edges.created).toBe(0);

    const changed = await load([issue(1), issue(2, { title: "Issue 2 renamed", dependencies: issues[1]?.dependencies ?? [] }), issue(3, { status: "in_progress" })], { project });
    const byId = new Map(items.map((r) => [r.id, r.externalId]));
    expect(changed.nodes).toEqual({ created: 0, updated: 2, unchanged: 2 });
    expect(changed.changedNodeIds.map((id) => byId.get(id)).sort()).toEqual([`${PREFIX}-2`, `${PREFIX}-3`]);
  });

  it("refuses an item owned by another project with nothing persisted", async () => {
    const owner = keyOf("owner");
    const intruder = keyOf("intruder");
    await load([issue(10)], { project: owner });

    const runsBefore = openIngestRunCalls();
    let thrown: unknown;
    try {
      await load([issue(10), issue(11)], { project: intruder, dir: DIR_B });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BeadsProjectConflictError);
    const e = thrown as BeadsProjectConflictError;
    expect(e.message).toContain(`${PREFIX}-10`);
    expect(e.message).toContain(owner);
    expect(e.message).toContain(intruder);

    expect(openIngestRunCalls()).toBe(runsBefore);
    expect(await rowsOf([`${PREFIX}-11`, `project:${intruder}`])).toEqual([]);
    const [kept] = await rowsOf([`${PREFIX}-10`]);
    expect(kept?.metadata).toMatchObject({ project: owner });
  });

  it("refuses a key registered at another path, naming both paths, with nothing persisted", async () => {
    const project = keyOf("moved");
    await load([issue(20)], { project });

    const runsBefore = openIngestRunCalls();
    let thrown: unknown;
    try {
      await load([issue(21)], { project, dir: DIR_B });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BeadsProjectConflictError);
    expect((thrown as Error).message).toContain(DIR_A);
    expect((thrown as Error).message).toContain(DIR_B);
    expect(openIngestRunCalls()).toBe(runsBefore);
    expect(await rowsOf([`${PREFIX}-21`])).toEqual([]);
  });

  it("adopts project-less existing items", async () => {
    const project = keyOf("adopt");
    const bare = await load([issue(30)], {});
    expect(bare).toMatchObject({ project: null, nodes: { created: 1 } });
    expect((await rowsOf([`${PREFIX}-30`]))[0]?.metadata).not.toHaveProperty("project");
    expect(await rowsOf([`project:${project}`])).toEqual([]);

    const adopted = await load([issue(30)], { project });
    expect(adopted.nodes).toEqual({ created: 1, updated: 1, unchanged: 0 });
    expect((await rowsOf([`${PREFIX}-30`]))[0]?.metadata).toMatchObject({ project });
  });

  it("refuses an invalid or empty project key naming project, before any write or run", async () => {
    const runsBefore = openIngestRunCalls();
    for (const project of ["Not Valid", "", "   "]) {
      let thrown: unknown;
      try {
        await load([issue(40)], { project });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InvalidWorkItemError);
      expect((thrown as InvalidWorkItemError).field).toBe("project");
    }
    expect(openIngestRunCalls()).toBe(runsBefore);
    expect(await rowsOf([`${PREFIX}-40`])).toEqual([]);
  });

  it("canonicalizes a padded key everywhere", async () => {
    const project = keyOf("padded");
    const result = await load([issue(41)], { project: `  ${project} ` });
    expect(result.project).toBe(project);
    expect((await rowsOf([`${PREFIX}-41`]))[0]?.metadata).toMatchObject({ project });
    expect(await rowsOf([`project:${project}`])).toHaveLength(1);
  });

  it("refuses a project-less load over an owned item, leaving project intact", async () => {
    const project = keyOf("strip");
    await load([issue(50)], { project });

    const runsBefore = openIngestRunCalls();
    let thrown: unknown;
    try {
      await load([issue(50, { title: "retitled" })], {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BeadsProjectConflictError);
    expect((thrown as Error).message).toContain(`${PREFIX}-50`);
    expect((thrown as Error).message).toContain(`--project ${project}`);
    expect(openIngestRunCalls()).toBe(runsBefore);
    expect((await rowsOf([`${PREFIX}-50`]))[0]).toMatchObject({ title: "Issue 50", metadata: { project } });
  });

  it("guards the exact row the upsert writes, not its merge survivor", async () => {
    const x = keyOf("mx");
    const y = keyOf("my");
    const z = keyOf("mz");
    await load([issue(60)], { project: x });
    await load([issue(61)], { project: y });
    await load([issue(62)], { project: z });
    await load([issue(63)], { project: y });
    const [loser60, survivor61, loser62, survivor63] = await Promise.all(
      [60, 61, 62, 63].map(async (n) => (await rowsOf([`${PREFIX}-${n}`]))[0]?.id as string),
    );
    const mergeRun = await openIngestRun(db, `beads`, { actor: "beads-ingest-test" });
    runIds.push(mergeRun.id);
    await mergeNodes(db, loser60 as string, survivor61 as string, mergeRun);
    await mergeNodes(db, loser62 as string, survivor63 as string, mergeRun);

    // Row 60 is owned by x and merged into a y-owned survivor: a z load is refused naming x, the row's own owner.
    let thrown: unknown;
    try {
      await load([issue(60)], { project: z });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BeadsProjectConflictError);
    expect((thrown as BeadsProjectConflictError).existing).toBe(x);
    expect((thrown as BeadsProjectConflictError).subject).toBe(`${PREFIX}-60`);

    // Row 62 is owned by z though its survivor belongs to y: a z load writes row 62 itself and is accepted.
    const accepted = await load([issue(62)], { project: z });
    expect(accepted.nodes.unchanged).toBeGreaterThanOrEqual(1);
  });

  it("treats a symlinked and a real path to one checkout as one registration", async () => {
    const project = keyOf("link");
    const link = path.join(ROOT, "link-to-a");
    symlinkSync(DIR_A, link);
    const viaLink = await load([issue(70)], { project, dir: link });
    expect(viaLink.path).toBe(DIR_A);
    const viaReal = await load([issue(70)], { project, dir: DIR_A });
    expect(viaReal.nodes).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect((await rowsOf([`project:${project}`]))[0]?.metadata).toMatchObject({ path: DIR_A });
  });

  it("errors saying so when the directory does not exist", async () => {
    await expect(load([issue(80)], { dir: path.join(ROOT, "nope") })).rejects.toThrow(/does not exist/);
  });

  it("reports changed only for node changes or created edges, never re-asserted edges", async () => {
    const project = keyOf("flag");
    const deps = [{ issue_id: `${PREFIX}-91`, depends_on_id: `${PREFIX}-90`, type: "blocks" }];
    const issues = [issue(90), issue(91, { dependencies: deps })];
    expect((await load(issues, { project })).changed).toBe(true);
    const again = await load(issues, { project });
    expect(again.edges.updated).toBe(1);
    expect(again.changed).toBe(false);
    expect((await load([issue(90), issue(91, { dependencies: deps, title: "new" })], { project })).changed).toBe(true);
  });

  it("removes stale dependencies before inserting their reversal", async () => {
    const project = keyOf("reversed");
    const a = `${PREFIX}-100`;
    const b = `${PREFIX}-101`;
    const first = [issue(100, { dependencies: [{ issue_id: a, depends_on_id: b, type: "blocks" }] }), issue(101)];
    await load(first, { project });

    const reversed = await load([
      issue(100),
      issue(101, { dependencies: [{ issue_id: b, depends_on_id: a, type: "blocks" }] }),
    ], { project });
    expect(reversed.nodes.unchanged).toBe(3);
    expect(reversed.edges).toEqual({ created: 1, updated: 0 });
    expect(reversed.edgesDeleted).toBe(1);
    expect(reversed.changed).toBe(true);

    const rows = await rowsOf([a, b]);
    const ids = new Map(rows.map((row) => [row.externalId, row.id]));
    const stored = await db.select({ srcId: edges.srcId, dstId: edges.dstId })
      .from(edges).where(and(eq(edges.sourceSystem, "beads"), inArray(edges.srcId, [...ids.values()])));
    expect(stored).toEqual([{ srcId: ids.get(a), dstId: ids.get(b) }]);

    const removed = await load([issue(100), issue(101)], { project });
    expect(removed.nodes.unchanged).toBe(3);
    expect(removed.edges).toEqual({ created: 0, updated: 0 });
    expect(removed.edgesDeleted).toBe(1);
    expect(removed.changed).toBe(true);
  });

  it("restores pruned edges if a replacement conflicts with another source", async () => {
    const project = keyOf("rollback");
    const a = `${PREFIX}-110`;
    const b = `${PREFIX}-111`;
    await load([issue(110, { dependencies: [{ issue_id: a, depends_on_id: b, type: "blocks" }] }), issue(111)], { project });
    const rows = await rowsOf([a, b]);
    const ids = new Map(rows.map((row) => [row.externalId, row.id]));
    const humanRun = await openIngestRun(db, "human", { actor: "beads-ingest-test" });
    runIds.push(humanRun.id);
    await upsertEdges(db, humanRun, [{ srcId: ids.get(b)!, dstId: ids.get(a)!, edgeType: "blocks", sourceSystem: "human" }]);

    await expect(load([
      issue(110),
      issue(111, { dependencies: [{ issue_id: b, depends_on_id: a, type: "blocks" }] }),
    ], { project })).rejects.toThrow(/23514/);

    const stored = await db.select({ srcId: edges.srcId, dstId: edges.dstId })
      .from(edges).where(and(eq(edges.sourceSystem, "beads"), inArray(edges.srcId, [...ids.values()])));
    expect(stored).toEqual([{ srcId: ids.get(b), dstId: ids.get(a) }]);
  });
});
