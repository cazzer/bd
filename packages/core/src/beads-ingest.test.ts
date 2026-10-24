// DB-backed tests for `ingestBeadsCheckout` (live-beads-board, task 1.5) with
// a fixture runner, so no `bd` binary is involved. The loader's source
// system is fixed ('beads'), so isolation comes from a unique bead-id
// prefix and unique project keys per suite; teardown deletes exactly what
// the suite wrote. No assertion reads a store-wide count.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { type BeadsIssue } from "./beads.js";
import { ingestBeadsCheckout, type IngestBeadsCheckoutResult, type RunBd } from "./beads-ingest.js";
import { BeadsProjectConflictError, InvalidWorkItemError } from "./errors.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 12);
const PREFIX = `bi${SUFFIX}`;
const keyOf = (name: string) => `${name}-${SUFFIX}`;
const DIR_A = "/tmp/beads-ingest-test-a";
const DIR_B = "/tmp/beads-ingest-test-b";

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

    expect(await rowsOf([`${PREFIX}-11`, `project:${intruder}`])).toEqual([]);
    const [kept] = await rowsOf([`${PREFIX}-10`]);
    expect(kept?.metadata).toMatchObject({ project: owner });
  });

  it("refuses a key registered at another path, naming both paths, with nothing persisted", async () => {
    const project = keyOf("moved");
    await load([issue(20)], { project });

    let thrown: unknown;
    try {
      await load([issue(21)], { project, dir: DIR_B });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BeadsProjectConflictError);
    expect((thrown as Error).message).toContain(DIR_A);
    expect((thrown as Error).message).toContain(DIR_B);
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

  it("refuses an invalid project key naming project, before any write", async () => {
    let thrown: unknown;
    try {
      await load([issue(40)], { project: "Not Valid" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidWorkItemError);
    expect((thrown as InvalidWorkItemError).field).toBe("project");
    expect(await rowsOf([`${PREFIX}-40`])).toEqual([]);
  });
});
