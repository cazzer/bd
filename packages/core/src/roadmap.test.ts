// DB-backed tests for `getRoadmap` (roadmap-milestones, tasks 2.2 and 2.3).
// Isolation as board.test.ts: every test uses its own project keys and this
// suite's own source system, and reads back only rows of those projects, so
// nothing asserts a store-wide count. Registry rows (for the all-projects
// read) are written under 'beads' with unique keys and deleted by key.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { ancestorAliasCte, buildAncestorWalkCte, getWorkBoard } from "./board.js";
import { upsertEdges } from "./edges.js";
import { InvalidLookupOptionError } from "./errors.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { MAX_RESOLVE_DEPTH } from "./views.js";
import { upsertNodes } from "./nodes.js";
import { getRoadmap, MAX_ROADMAP_ROWS, type Roadmap, type RoadmapEpic, type RoadmapMilestone, type RoadmapProgress } from "./roadmap.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 10);
const SRC = `roadmap-test-${SUFFIX}`;

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
let beadsRun: IngestRunHandle;
let testNo = 0;
const registered: string[] = [];
const extraRunIds: string[] = [];

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC, { actor: "roadmap-test" });
  beadsRun = await openIngestRun(db, "beads", { actor: "roadmap-test" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await closeIngestRun(db, beadsRun);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  if (registered.length > 0) {
    await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, registered.map((k) => `project:${k}`))));
  }
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id, beadsRun.id, ...extraRunIds]));
  await pool.end();
});

function scope() {
  testNo += 1;
  const tag = `${SUFFIX}-${testNo}`;
  return { a: `ra-${tag}`, b: `rb-${tag}`, tag };
}

async function register(...keys: string[]): Promise<void> {
  registered.push(...keys);
  await upsertNodes(
    db,
    beadsRun,
    keys.map((k) => ({ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${k}`, title: k, content: "", metadata: { project: k, path: `/tmp/${k}` } })),
  );
}

interface Spec {
  ext: string;
  project: string;
  status?: string;
  issueType?: string;
  title?: string;
  /** Written raw (no contract normalization), so a test can store a malformed value. */
  dueAt?: unknown;
  startedAt?: unknown;
  closedAt?: unknown;
}

async function items(specs: Spec[]): Promise<Map<string, string>> {
  const result = await upsertNodes(
    db,
    run,
    specs.map((s) => ({
      nodeType: "work_item",
      sourceSystem: SRC,
      externalId: s.ext,
      title: s.title ?? s.ext,
      content: "",
      metadata: {
        project: s.project,
        status: s.status ?? "open",
        priority: 2,
        ...(s.issueType ? { issue_type: s.issueType } : {}),
        ...(s.dueAt !== undefined ? { due_at: s.dueAt } : {}),
        ...(s.startedAt !== undefined ? { started_at: s.startedAt } : {}),
        ...(s.closedAt !== undefined ? { closed_at: s.closedAt } : {}),
      },
    })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

async function childOf(pairs: Array<[string, string]>): Promise<void> {
  await upsertEdges(
    db,
    run,
    pairs.map(([srcId, dstId]) => ({ srcId, dstId, edgeType: "child_of", sourceSystem: SRC })),
  );
}

/** Tasks under `parent`: `closed` closed ones, then the rest open. */
function tasks(tag: string, project: string, prefix: string, statuses: string[]): Spec[] {
  return statuses.map((status, i) => ({ ext: `${tag}-${prefix}${i}`, project, status }));
}

function epic(roadmap: Roadmap, id: string): RoadmapEpic {
  const found = roadmap.epics.find((e) => e.id === id);
  if (!found) throw new Error(`no epic ${id}`);
  return found;
}

function milestone(roadmap: Roadmap, id: string): RoadmapMilestone {
  const found = roadmap.milestones.find((m) => m.id === id);
  if (!found) throw new Error(`no milestone ${id}`);
  return found;
}

/** The share the view draws (work-roadmap spec): closed / (total − deferred), none when empty. */
function share(p: RoadmapProgress): number | null {
  const denominator = p.total - p.deferred;
  return denominator === 0 ? null : Math.round((100 * p.closed) / denominator);
}

const progress = (total: number, closed: number, inProgress = 0, deferred = 0): RoadmapProgress => ({
  total,
  closed,
  inProgress,
  deferred,
  open: total - closed - inProgress - deferred,
});

describe("getRoadmap rollup", () => {
  it("rolls a milestone up across two epics: 75%, 25%, 50%", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone", title: "Beta", dueAt: "2026-12-15T00:00:00.000Z" },
      { ext: `${tag}-ea`, project: a, issueType: "epic", title: "A" },
      { ext: `${tag}-eb`, project: a, issueType: "epic", title: "B" },
      ...tasks(tag, a, "a", ["closed", "closed", "closed", "open"]),
      ...tasks(tag, a, "b", ["closed", "in_progress", "open", "open"]),
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("ea"), id("m")],
      [id("eb"), id("m")],
      ...[0, 1, 2, 3].map((i): [string, string] => [id(`a${i}`), id("ea")]),
      ...[0, 1, 2, 3].map((i): [string, string] => [id(`b${i}`), id("eb")]),
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("ea")).progress).toEqual(progress(4, 3));
    expect(epic(roadmap, id("eb")).progress).toEqual(progress(4, 1, 1));
    expect(milestone(roadmap, id("m")).progress).toEqual(progress(8, 4, 1));
    expect(milestone(roadmap, id("m")).unepicked).toEqual(progress(0, 0));
    expect([share(epic(roadmap, id("ea")).progress), share(epic(roadmap, id("eb")).progress), share(milestone(roadmap, id("m")).progress)]).toEqual([75, 25, 50]);
    expect(epic(roadmap, id("ea")).milestone).toEqual({ id: id("m"), externalId: `${tag}-m`, title: "Beta", status: "open", project: a, dueAt: "2026-12-15T00:00:00.000Z" });
    expect(milestone(roadmap, id("m"))).toMatchObject({ externalId: `${tag}-m`, title: "Beta", status: "open", project: a, dueAt: "2026-12-15T00:00:00.000Z" });
    expect(roadmap.truncated).toBe(false);
    // Leaves are counted, never returned; no content either.
    expect(roadmap.epics.map((e) => e.id).sort()).toEqual([id("ea"), id("eb")].sort());
    expect(roadmap.milestones.map((m) => m.id)).toEqual([id("m")]);
    expect(roadmap.epics[0]).not.toHaveProperty("content");
  });

  it("counts deferred items but leaves them out of the share, and gives an empty epic no share", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-e`, project: a, issueType: "epic" },
      { ext: `${tag}-empty`, project: a, issueType: "epic" },
      ...tasks(tag, a, "t", ["closed", "closed", "open", "blocked", "deferred"]),
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([0, 1, 2, 3, 4].map((i): [string, string] => [id(`t${i}`), id("e")]));

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("e")).progress).toEqual(progress(5, 2, 0, 1));
    expect(share(epic(roadmap, id("e")).progress)).toBe(50);
    expect(epic(roadmap, id("empty")).progress).toEqual(progress(0, 0));
    expect(share(epic(roadmap, id("empty")).progress)).toBeNull();
    expect(epic(roadmap, id("empty")).firstStartedAt).toBeNull();
    expect(epic(roadmap, id("empty")).milestone).toBeNull();
  });

  it("counts a nested epic's items in both epics", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-outer`, project: a, issueType: "epic" },
      { ext: `${tag}-inner`, project: a, issueType: "epic" },
      { ext: `${tag}-deep`, project: a, status: "closed" },
      { ext: `${tag}-shallow`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("inner"), id("outer")],
      [id("deep"), id("inner")],
      [id("shallow"), id("outer")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("inner")).progress).toEqual(progress(1, 1));
    expect(epic(roadmap, id("outer")).progress).toEqual(progress(2, 1));
  });

  it("counts a task reached twice through a child_of cycle once, in its epic and its milestone", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone" },
      { ext: `${tag}-e`, project: a, issueType: "epic" },
      { ext: `${tag}-p`, project: a, status: "closed" },
      { ext: `${tag}-q`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("p"), id("q")],
      [id("q"), id("p")],
      [id("q"), id("e")],
      [id("e"), id("m")],
      // And a cycle through the milestone and the epic themselves.
      [id("m"), id("e")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("e")).progress).toEqual(progress(2, 1));
    expect(milestone(roadmap, id("m")).progress).toEqual(progress(2, 1));
    expect(milestone(roadmap, id("m")).unepicked).toEqual(progress(0, 0));
    expect(epic(roadmap, id("e")).milestone?.id).toBe(id("m"));
  });

  it("walks no further than the first milestone on a path, so a cycle above it does not run to the depth cap", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone" },
      { ext: `${tag}-e`, project: a, issueType: "epic" },
      { ext: `${tag}-t`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("t"), id("e")],
      [id("e"), id("m")],
      [id("m"), id("e")],
    ]);
    const deepest = async (stopAtMilestone: boolean) => {
      const result = await db.execute<{ depth: number; rows: number }>(sql`
        WITH RECURSIVE ${ancestorAliasCte()},
        ${buildAncestorWalkCte("walk", sql`SELECT ${id("t")}::uuid AS id`, { stopAtMilestone })}
        SELECT max(depth)::int AS depth, count(*)::int AS rows FROM walk`);
      return result.rows[0]!;
    };

    expect(await deepest(true)).toEqual({ depth: 2, rows: 3 });
    expect((await deepest(false)).depth).toBe(MAX_RESOLVE_DEPTH);
  });

  it("folds merges: an edge on a merged-away epic or a merged-away duplicate leaf counts for the survivor, once", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone", title: "M" },
      { ext: `${tag}-survivor`, project: a, issueType: "epic" },
      { ext: `${tag}-loser`, project: a, issueType: "epic" },
      { ext: `${tag}-t1`, project: a, status: "closed" },
      { ext: `${tag}-t2`, project: a },
      { ext: `${tag}-t2-dup`, project: a, status: "closed" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      // Asserted on the merged-away epic: its milestone link and a child's link fold onto the survivor.
      [id("loser"), id("m")],
      [id("t1"), id("loser")],
      // Only the duplicate carries t2's link; t2 is reached through it, and the duplicate is not counted itself.
      [id("t2-dup"), id("survivor")],
    ]);
    const mergeRun = await openIngestRun(db, SRC, { actor: "roadmap-test-merge" });
    try {
      await mergeNodes(db, id("loser"), id("survivor"), mergeRun);
      await mergeNodes(db, id("t2-dup"), id("t2"), mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(roadmap.epics.map((e) => e.id)).toEqual([id("survivor")]);
    expect(epic(roadmap, id("survivor")).progress).toEqual(progress(2, 1));
    expect(epic(roadmap, id("survivor")).milestone).toMatchObject({ id: id("m"), title: "M", dueAt: null });
    expect(milestone(roadmap, id("m")).progress).toEqual(progress(2, 1));
    expect(milestone(roadmap, id("m")).unepicked).toEqual(progress(0, 0));
  });

  it("counts a task directly under a milestone only toward the milestone and its items outside epics", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone" },
      { ext: `${tag}-e`, project: a, issueType: "epic" },
      { ext: `${tag}-direct`, project: a, status: "in_progress" },
      { ext: `${tag}-t`, project: a, status: "closed" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("e"), id("m")],
      [id("t"), id("e")],
      [id("direct"), id("m")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("e")).progress).toEqual(progress(1, 1));
    expect(milestone(roadmap, id("m")).progress).toEqual(progress(2, 1, 1));
    expect(milestone(roadmap, id("m")).unepicked).toEqual(progress(1, 0, 1));
  });

  it("treats a milestone as a boundary: an epic above a milestone counts none of the items under it, and no item counts under two milestones", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-top`, project: a, issueType: "milestone" },
      { ext: `${tag}-outer`, project: a, issueType: "epic" },
      { ext: `${tag}-m`, project: a, issueType: "milestone" },
      { ext: `${tag}-inner`, project: a, issueType: "epic" },
      { ext: `${tag}-x`, project: a },
      { ext: `${tag}-t`, project: a, status: "closed" },
      { ext: `${tag}-own`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("outer"), id("top")],
      [id("m"), id("outer")],
      [id("x"), id("m")],
      [id("inner"), id("m")],
      [id("t"), id("inner")],
      [id("own"), id("outer")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("outer")).progress).toEqual(progress(1, 0));
    expect(epic(roadmap, id("outer")).milestone?.id).toBe(id("top"));
    expect(epic(roadmap, id("inner")).progress).toEqual(progress(1, 1));
    expect(epic(roadmap, id("inner")).milestone?.id).toBe(id("m"));
    expect(milestone(roadmap, id("m")).progress).toEqual(progress(2, 1));
    expect(milestone(roadmap, id("m")).unepicked).toEqual(progress(1, 0));
    // `own` belongs to top through outer; x and t stop at m.
    expect(milestone(roadmap, id("top")).progress).toEqual(progress(1, 0));
    expect(milestone(roadmap, id("top")).unepicked).toEqual(progress(0, 0));
  });
});

describe("getRoadmap dates", () => {
  it("starts an epic at its earliest item's started_at, and reads its own dates", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-e`, project: a, issueType: "epic" },
      { ext: `${tag}-own`, project: a, issueType: "epic", status: "closed", startedAt: "2026-09-01T10:00:00.000Z", closedAt: "2026-10-20T00:00:00.000Z", dueAt: "2026-10-31T00:00:00.000Z" },
      { ext: `${tag}-late`, project: a, startedAt: "2026-10-05T12:00:00.000Z" },
      { ext: `${tag}-early`, project: a, status: "closed", startedAt: "2026-10-01T08:30:00.000Z" },
      { ext: `${tag}-never`, project: a },
      { ext: `${tag}-elsewhere`, project: a, startedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("late"), id("e")],
      [id("early"), id("e")],
      [id("never"), id("e")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(epic(roadmap, id("e"))).toMatchObject({ startedAt: null, closedAt: null, dueAt: null, firstStartedAt: "2026-10-01T08:30:00.000Z" });
    expect(epic(roadmap, id("own"))).toMatchObject({
      status: "closed",
      startedAt: "2026-09-01T10:00:00.000Z",
      closedAt: "2026-10-20T00:00:00.000Z",
      dueAt: "2026-10-31T00:00:00.000Z",
      firstStartedAt: null,
    });
  });

  it("reads a stored date not in the canonical form as absent, without failing the read", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m`, project: a, issueType: "milestone", dueAt: "2026-12-15" },
      { ext: `${tag}-e`, project: a, issueType: "epic", dueAt: "next week", startedAt: 1767225600000, closedAt: { at: "x" } },
      { ext: `${tag}-bad`, project: a, startedAt: "2026-10-01T08:30:00Z" },
      { ext: `${tag}-good`, project: a, startedAt: "2026-10-09T00:00:00.000Z" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("bad"), id("e")],
      [id("good"), id("e")],
    ]);

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(milestone(roadmap, id("m")).dueAt).toBeNull();
    expect(epic(roadmap, id("e"))).toMatchObject({ dueAt: null, startedAt: null, closedAt: null, firstStartedAt: "2026-10-09T00:00:00.000Z" });
  });

  it("orders milestones by due, undated last, then title; and returns the due dates the view orders by", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-mar`, project: a, issueType: "milestone", title: "March", dueAt: "2027-03-01T00:00:00.000Z" },
      { ext: `${tag}-none-z`, project: a, issueType: "milestone", title: "Zed" },
      { ext: `${tag}-jan`, project: a, issueType: "milestone", title: "January", dueAt: "2027-01-15T00:00:00.000Z" },
      { ext: `${tag}-none-a`, project: a, issueType: "milestone", title: "Alpha" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;

    const roadmap = await getRoadmap(db, { projects: [a] });

    expect(roadmap.milestones.map((m) => m.id)).toEqual([id("jan"), id("mar"), id("none-a"), id("none-z")]);
    expect(roadmap.milestones.map((m) => m.dueAt)).toEqual(["2027-01-15T00:00:00.000Z", "2027-03-01T00:00:00.000Z", null, null]);
  });
});

describe("getRoadmap projects and bounds", () => {
  it("reads only the named projects, and every registered project when none is named", async () => {
    const { a, b, tag } = scope();
    await register(a, b);
    const ids = await items([
      { ext: `${tag}-ea`, project: a, issueType: "epic" },
      { ext: `${tag}-ma`, project: a, issueType: "milestone" },
      { ext: `${tag}-eb`, project: b, issueType: "epic" },
      { ext: `${tag}-tb`, project: b },
      { ext: `${tag}-escratch`, project: `scratch-${tag}`, issueType: "epic" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    // A task of b under a's epic is not counted when only a is read.
    await childOf([[id("tb"), id("ea")]]);

    const onlyA = await getRoadmap(db, { projects: [a] });
    expect(onlyA.epics.map((e) => e.id)).toEqual([id("ea")]);
    expect(onlyA.milestones.map((m) => m.id)).toEqual([id("ma")]);
    expect(epic(onlyA, id("ea")).progress.total).toBe(0);

    const both = await getRoadmap(db, { projects: [a, b] });
    expect(both.epics.map((e) => e.id)).toEqual([id("ea"), id("eb")]);
    expect(epic(both, id("ea")).progress.total).toBe(1);

    const all = await getRoadmap(db);
    const mine = all.epics.filter((e) => e.externalId.startsWith(`${tag}-`));
    expect(mine.map((e) => e.id).sort()).toEqual([id("ea"), id("eb")].sort());
  });

  it("names an epic's milestone in a project not shown, with its external id, project, status, and due date, without listing or counting it", async () => {
    const { a, b, tag } = scope();
    const ids = await items([
      { ext: `${tag}-mb`, project: b, issueType: "milestone", title: "Launch", status: "closed", dueAt: "2027-02-01T00:00:00.000Z" },
      { ext: `${tag}-ea`, project: a, issueType: "epic" },
      { ext: `${tag}-ta`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("ea"), id("mb")],
      [id("ta"), id("ea")],
    ]);

    const onlyA = await getRoadmap(db, { projects: [a] });

    expect(onlyA.milestones).toEqual([]);
    expect(epic(onlyA, id("ea")).milestone).toEqual({ id: id("mb"), externalId: `${tag}-mb`, title: "Launch", status: "closed", project: b, dueAt: "2027-02-01T00:00:00.000Z" });
    expect(epic(onlyA, id("ea")).progress.total).toBe(1);
    // Read with b too, the milestone counts a's task through a's epic.
    expect(milestone(await getRoadmap(db, { projects: [a, b] }), id("mb")).progress.total).toBe(1);
  });

  it("answers an empty roadmap for an explicit empty selection", async () => {
    expect(await getRoadmap(db, { projects: [] })).toEqual({ milestones: [], epics: [], truncated: false });
  });

  it("refuses a malformed project list naming projects, as the board does, and a bad cap", async () => {
    await expect(getRoadmap(db, { projects: ["Tides"] })).rejects.toMatchObject({ option: "projects" });
    await expect(getRoadmap(db, { projects: Array.from({ length: 21 }, (_, i) => `k${i}`) })).rejects.toMatchObject({ option: "projects" });
    await expect(getRoadmap(db, { projects: ["Tides"] })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getRoadmap(db, { maxRows: 0 })).rejects.toMatchObject({ option: "maxRows" });
    await expect(getRoadmap(db, { maxRows: MAX_ROADMAP_ROWS + 1 })).rejects.toMatchObject({ option: "maxRows" });
  });

  it("caps milestones plus epics, keeping milestones and open epics first, and says truncated", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-m1`, project: a, issueType: "milestone" },
      { ext: `${tag}-m2`, project: a, issueType: "milestone", status: "closed" },
      { ext: `${tag}-closed`, project: a, issueType: "epic", status: "closed" },
      { ext: `${tag}-open`, project: a, issueType: "epic" },
      { ext: `${tag}-t`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;

    const cut = await getRoadmap(db, { projects: [a], maxRows: 3 });
    expect(cut.truncated).toBe(true);
    expect(cut.milestones.map((m) => m.id).sort()).toEqual([id("m1"), id("m2")].sort());
    expect(cut.epics.map((e) => e.id)).toEqual([id("open")]);

    const exact = await getRoadmap(db, { projects: [a], maxRows: 4 });
    expect(exact.truncated).toBe(false);
    expect(exact.epics).toHaveLength(2);
  });
});

describe("getRoadmap and getWorkBoard agree on ancestry (tasks 2.3)", () => {
  it("counts every card under its board epic, and every no-epic card under a milestone as outside epics", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-top`, project: a, issueType: "milestone" },
      { ext: `${tag}-outer`, project: a, issueType: "epic" },
      { ext: `${tag}-m`, project: a, issueType: "milestone" },
      { ext: `${tag}-inner`, project: a, issueType: "epic" },
      { ext: `${tag}-side`, project: a, issueType: "epic" },
      { ext: `${tag}-x`, project: a },
      { ext: `${tag}-t1`, project: a, status: "closed" },
      { ext: `${tag}-t2`, project: a },
      { ext: `${tag}-p`, project: a },
      { ext: `${tag}-q`, project: a, status: "deferred" },
      { ext: `${tag}-own`, project: a },
      { ext: `${tag}-loose`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await childOf([
      [id("outer"), id("top")],
      [id("m"), id("outer")],
      [id("x"), id("m")],
      [id("inner"), id("m")],
      [id("side"), id("inner")],
      [id("t1"), id("inner")],
      [id("t2"), id("side")],
      [id("p"), id("q")],
      [id("q"), id("p")],
      [id("q"), id("side")],
      [id("own"), id("outer")],
    ]);
    // Epic nesting below any milestone boundary, from the fixture: side is inside inner.
    const nestedIn: Record<string, string[]> = { [id("inner")]: [id("side")] };

    const [board, roadmap] = await Promise.all([getWorkBoard(db, { projects: [a] }), getRoadmap(db, { projects: [a] })]);

    expect(board.cards).toHaveLength(7);
    for (const e of roadmap.epics) {
      const within = new Set([e.id, ...(nestedIn[e.id] ?? [])]);
      const onBoard = board.cards.filter((c) => c.epicId !== null && within.has(c.epicId));
      expect(e.progress.total, e.externalId).toBe(onBoard.length);
      expect(e.progress.closed, e.externalId).toBe(onBoard.filter((c) => c.status === "closed").length);
      expect(e.progress.deferred, e.externalId).toBe(onBoard.filter((c) => c.status === "deferred").length);
    }
    for (const c of board.cards) {
      if (c.epicId !== null) expect(roadmap.epics.map((e) => e.id)).toContain(c.epicId);
    }
    expect(board.epics.map((e) => e.id).sort()).toEqual(roadmap.epics.map((e) => e.id).sort());
    for (const e of board.epics) {
      expect(e.milestone?.id ?? null, e.title).toBe(epic(roadmap, e.id).milestone?.id ?? null);
    }
    // x is the one no-epic card under a milestone; loose is under none.
    expect(board.cards.filter((c) => c.epicId === null).map((c) => c.id).sort()).toEqual([id("x"), id("loose")].sort());
    expect(roadmap.milestones.reduce((n, m) => n + m.unepicked.total, 0)).toBe(1);
    expect(milestone(roadmap, id("m")).unepicked.total).toBe(1);
  });
});
