// The two halves of the beads load (laptop-relay decisions 4 and 9):
// `computeBeadsIngest` runs `bd` with no database at all, and
// `applyBeadsIngest` writes what it computed, attributed to the actor it is
// given. beads-ingest.test.ts proves the composed `ingestBeadsCheckout`
// unchanged; this file proves each half alone.
//
// Isolation as in beads-ingest.test.ts: a unique bead-id prefix and project
// keys, teardown by that prefix and by run id, no store-wide count.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { type BeadsIssue } from "./beads.js";
import { applyBeadsIngest, computeBeadsIngest, parseBeadsIssues, type RunBd } from "./beads-ingest.js";
import { BeadsProjectConflictError } from "./errors.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 12);
const PREFIX = `bs${SUFFIX}`;
const keyOf = (name: string) => `${name}-${SUFFIX}`;
const ACTOR = `test-relay-${SUFFIX}`;
const SCRATCH = mkdtempSync(path.join(tmpdir(), "beads-split-test-"));
const ROOT = realpathSync(SCRATCH);

function issue(n: number, overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return { id: `${PREFIX}-${n}`, title: `Issue ${n}`, status: "open", priority: 2, issue_type: "task", created_at: "2026-09-01T10:00:00Z", ...overrides };
}

/** A runner answering `bd list` with `issues` and `bd comments <id>` from `threads`, recording every call. */
function fixture(issues: unknown, threads: Record<string, unknown> = {}): { runBd: RunBd; calls: string[][] } {
  const calls: string[][] = [];
  const runBd: RunBd = async (args) => {
    calls.push([...args]);
    if (args[0] === "list") return JSON.stringify(issues);
    if (args[0] === "comments") return JSON.stringify(threads[args[1]!] ?? []);
    throw new Error(`unexpected bd ${args.join(" ")}`);
  };
  return { runBd, calls };
}

const review = (n: number, commentCount: number): BeadsIssue => issue(n, { labels: ["review"], comment_count: commentCount });
const thread = (text: string) => [{ id: 1, author: "caleb", text, created_at: "2026-09-02T10:00:00Z" }];

describe("computeBeadsIngest (no database)", () => {
  it("returns the export and every review thread with comments, fetching each", async () => {
    const issues = [issue(1), review(2, 1), review(3, 0)];
    const { runBd, calls } = fixture(issues, { [`${PREFIX}-2`]: thread("looks good") });
    const computed = await computeBeadsIngest(runBd, "/checkout");
    expect(computed.issues).toEqual(issues);
    expect(computed.comments).toEqual({ [`${PREFIX}-2`]: thread("looks good") });
    expect(calls).toEqual([
      ["list", "--status=all", "--limit=0", "--json"],
      ["comments", `${PREFIX}-2`, "--json"],
    ]);
  });

  it("carries a prior thread forward when its count matches, and fetches the rest", async () => {
    const issues = [review(1, 2), review(2, 3)];
    const { runBd, calls } = fixture(issues, { [`${PREFIX}-2`]: thread("fresh") });
    const asked: string[][] = [];
    const computed = await computeBeadsIngest(runBd, "/checkout", {
      priorThreads: async (wanted) => {
        asked.push(wanted.map((i) => i.id));
        return new Map([
          [`${PREFIX}-1`, { count: 2, comments: thread("stored") }],
          [`${PREFIX}-2`, { count: 1, comments: thread("stale") }],
        ]);
      },
    });
    expect(asked).toEqual([[`${PREFIX}-1`, `${PREFIX}-2`]]);
    expect(computed.comments).toEqual({ [`${PREFIX}-1`]: thread("stored"), [`${PREFIX}-2`]: thread("fresh") });
    expect(calls.filter((c) => c[0] === "comments")).toEqual([["comments", `${PREFIX}-2`, "--json"]]);
  });

  it("never asks for prior threads when no review has comments", async () => {
    const { runBd } = fixture([issue(1)]);
    let asked = false;
    await computeBeadsIngest(runBd, "/checkout", {
      priorThreads: async () => {
        asked = true;
        return new Map();
      },
    });
    expect(asked).toBe(false);
  });

  it("refuses an empty export, a non-array, a row missing its title, and a malformed thread", async () => {
    await expect(computeBeadsIngest(fixture([]).runBd, "/c")).rejects.toThrow("no issues to ingest");
    await expect(computeBeadsIngest(fixture({}).runBd, "/c")).rejects.toThrow("did not return an array");
    await expect(computeBeadsIngest(fixture([{ id: "x-1", status: "open" }]).runBd, "/c")).rejects.toThrow("row 0 is missing id, title, or status");
    await expect(computeBeadsIngest(fixture([review(1, 1)], { [`${PREFIX}-1`]: { not: "an array" } }).runBd, "/c")).rejects.toThrow("did not return an array");
  });
});

describe("parseBeadsIssues", () => {
  it("passes valid rows through untouched and names the first bad one", () => {
    const rows = [{ id: "a-1", title: "t", status: "open", extra: true }];
    expect(parseBeadsIssues(rows)).toBe(rows);
    expect(() => parseBeadsIssues([rows[0], { id: "a-2", title: 3, status: "open" }])).toThrow("row 1 is missing id, title, or status");
  });
});

describe("applyBeadsIngest", () => {
  let pool: TestPool;
  let db: Database;
  const runIds: string[] = [];

  beforeAll(() => {
    ({ pool, db } = connectTestDb());
  });

  afterAll(async () => {
    await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), or(like(nodes.externalId, `${PREFIX}-%`), like(nodes.externalId, `project:%-${SUFFIX}`))));
    if (runIds.length > 0) await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
    await pool.end();
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("records the actor on its run; a re-apply of the same data is all unchanged", async () => {
    const project = keyOf("pushed");
    const issues = [issue(1), review(2, 1), issue(3, { dependencies: [{ issue_id: `${PREFIX}-3`, depends_on_id: `${PREFIX}-1`, type: "blocks" }] })];
    const comments = { [`${PREFIX}-2`]: thread("from the relay") };

    const first = await applyBeadsIngest(db, { project, path: ROOT, issues, comments, actor: ACTOR });
    runIds.push(first.ingestRunId);
    expect(first).toMatchObject({ project, path: ROOT, nodes: { created: 4, updated: 0, unchanged: 0 }, edges: { created: 1 }, changed: true });
    const [run] = await db.select().from(ingestRuns).where(eq(ingestRuns.id, first.ingestRunId));
    expect(run).toMatchObject({ sourceSystem: "beads", actor: ACTOR });
    const [registry] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `project:${project}`)));
    expect(registry!.metadata).toEqual({ project, path: ROOT });
    const [reviewed] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `${PREFIX}-2`)));
    expect((reviewed!.metadata as Record<string, unknown>)["review_comments"]).toHaveLength(1);

    const second = await applyBeadsIngest(db, { project, path: ROOT, issues, comments });
    runIds.push(second.ingestRunId);
    expect(second).toMatchObject({ nodes: { created: 0, updated: 0, unchanged: 4 }, edges: { created: 0 }, edgesDeleted: 0, changed: false, changedNodeIds: [] });
    const [defaultRun] = await db.select().from(ingestRuns).where(eq(ingestRuns.id, second.ingestRunId));
    expect(defaultRun!.actor).toBe("ingest:beads");
  });

  it("still refuses an item another project owns, and a key registered at another path, opening no run", async () => {
    const owner = keyOf("owner");
    const owned = await applyBeadsIngest(db, { project: owner, path: ROOT, issues: [issue(10)], comments: {} });
    runIds.push(owned.ingestRunId);

    const thief = applyBeadsIngest(db, { project: keyOf("thief"), path: ROOT, issues: [issue(10)], comments: {}, actor: ACTOR });
    await expect(thief).rejects.toBeInstanceOf(BeadsProjectConflictError);
    const moved = applyBeadsIngest(db, { project: owner, path: path.join(ROOT, "elsewhere"), issues: [issue(10)], comments: {} });
    await expect(moved).rejects.toMatchObject({ kind: "path" });
    const runs = await db.select({ id: ingestRuns.id }).from(ingestRuns).where(eq(ingestRuns.actor, ACTOR));
    // The only relay-attributed run in this suite is the first test's.
    expect(runs.map((r) => r.id)).toEqual([runIds[0]]);
  });
});
