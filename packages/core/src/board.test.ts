// DB-backed tests for `getWorkBoard` / `listBeadsProjects` (live-beads-board,
// task 2.2). Isolation: every test uses its own project keys (a per-test
// suffix on a per-suite one) and this suite's own source system, and reads
// back only cards of those projects, so nothing asserts a store-wide count
// (`bd memories test-no-run-opened-assertions`). The registry test writes
// under source system 'beads' (the only one `listBeadsProjects` reads) with
// a unique key and deletes exactly those rows.

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { getBoardItem, getRegisteredBeadsProject, getWorkBoard, listBeadsProjects, CLOSED_PER_PROJECT, type BoardCard, type WorkBoard } from "./board.js";
import { mergeNodes } from "./merge.js";
import { getWorkItemReadiness } from "./work-items.js";
import { upsertEdges } from "./edges.js";
import { InvalidLookupOptionError } from "./errors.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 10);
const SRC = `board-test-${SUFFIX}`;
const REGISTRY_KEY = `reg-${SUFFIX}`;

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
let beadsRun: IngestRunHandle;
let testNo = 0;
const registered: string[] = [];
const extraRunIds: string[] = [];

/** Registers project keys the way beads-ingest.ts does, so the all-projects board offers them. */
async function register(...keys: string[]): Promise<void> {
  registered.push(...keys);
  await upsertNodes(
    db,
    beadsRun,
    keys.map((k) => ({ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${k}`, title: k, content: "", metadata: { project: k, path: `/tmp/${k}` } })),
  );
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC, { actor: "board-test" });
  beadsRun = await openIngestRun(db, "beads", { actor: "board-test" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await closeIngestRun(db, beadsRun);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, [`project:${REGISTRY_KEY}`, ...registered.map((k) => `project:${k}`)])));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id, beadsRun.id, ...extraRunIds]));
  await pool.end();
});

/** A fresh pair of project keys (and an id prefix) for one test. */
function scope() {
  testNo += 1;
  const tag = `${SUFFIX}-${testNo}`;
  return { a: `pa-${tag}`, b: `pb-${tag}`, tag };
}

interface Spec {
  ext: string;
  project: string;
  status?: string;
  rawPriority?: unknown;
  specId?: string;
  priority?: number;
  issueType?: string;
  closedAt?: string;
  title?: string;
}

/** Writes work items in one batch; returns external id -> node id. */
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
        priority: "rawPriority" in s ? s.rawPriority : (s.priority ?? 2),
        ...(s.specId ? { spec_id: s.specId } : {}),
        ...(s.issueType ? { issue_type: s.issueType } : {}),
        ...(s.closedAt ? { closed_at: s.closedAt } : {}),
      },
    })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

async function link(srcId: string, dstId: string, edgeType: "blocks" | "child_of"): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType, sourceSystem: SRC }]);
}

function card(board: WorkBoard, id: string): BoardCard {
  const found = board.cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
}

describe("getWorkBoard columns", () => {
  it("places each item in exactly one column per the work-board spec", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-ready`, project: a },
      { ext: `${tag}-blocker`, project: a, status: "in_progress" },
      { ext: `${tag}-blocked`, project: a },
      { ext: `${tag}-freed`, project: a },
      { ext: `${tag}-doneblocker`, project: a, status: "closed", closedAt: "2026-09-01T00:00:00.000Z" },
      { ext: `${tag}-statusblocked`, project: a, status: "blocked" },
      { ext: `${tag}-wip`, project: a, status: "in_progress" },
      { ext: `${tag}-wipblocked`, project: a, status: "in_progress" },
      { ext: `${tag}-deferred`, project: a, status: "deferred" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("blocker"), id("blocked"), "blocks");
    await link(id("doneblocker"), id("freed"), "blocks");
    await link(id("blocker"), id("wipblocked"), "blocks");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(board.cards).toHaveLength(9);
    expect(card(board, id("ready")).column).toBe("ready");
    expect(card(board, id("blocked")).column).toBe("blocked");
    expect(card(board, id("blocked")).openBlockerIds).toEqual([id("blocker")]);
    expect(card(board, id("blocked")).blockedFlag).toBe(true);
    expect(card(board, id("freed")).column).toBe("ready");
    expect(card(board, id("freed")).openBlockerIds).toEqual([]);
    expect(card(board, id("statusblocked")).column).toBe("blocked");
    expect(card(board, id("statusblocked")).openBlockerIds).toEqual([]);
    expect(card(board, id("wip")).column).toBe("in_progress");
    expect(card(board, id("wip")).blockedFlag).toBe(false);
    const wipBlocked = card(board, id("wipblocked"));
    expect(wipBlocked.column).toBe("in_progress");
    expect(wipBlocked.blockedFlag).toBe(true);
    expect(wipBlocked.openBlockerIds).toEqual([id("blocker")]);
    expect(card(board, id("deferred")).column).toBe("deferred");
    expect(card(board, id("doneblocker")).column).toBe("closed");
    expect(card(board, id("ready")).blockedFlag).toBe(false);
  });

  it("counts a blocker in another project as open, and a closed one stops counting", async () => {
    const { a, b, tag } = scope();
    const ids = await items([
      { ext: `${tag}-x`, project: a },
      { ext: `${tag}-y`, project: b },
      { ext: `${tag}-z`, project: a },
      { ext: `${tag}-w`, project: b, status: "closed", closedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("y"), id("x"), "blocks");
    await link(id("w"), id("z"), "blocks");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(board.cards.map((c) => c.id).sort()).toEqual([id("x"), id("z")].sort());
    expect(card(board, id("x")).column).toBe("blocked");
    expect(card(board, id("x")).openBlockerIds).toEqual([id("y")]);
    expect(card(board, id("z")).column).toBe("ready");
  });

  it("orders cards by priority, then most recently updated", async () => {
    const { a, tag } = scope();
    const low = await items([{ ext: `${tag}-low`, project: a, priority: 3 }]);
    const oldUrgent = await items([{ ext: `${tag}-old`, project: a, priority: 1 }]);
    const newUrgent = await items([{ ext: `${tag}-new`, project: a, priority: 1 }]);

    const board = await getWorkBoard(db, { projects: [a] });

    expect(board.cards.map((c) => c.id)).toEqual([newUrgent.get(`${tag}-new`), oldUrgent.get(`${tag}-old`), low.get(`${tag}-low`)]);
  });

  it("returns no content and carries the card fields", async () => {
    const { a, tag } = scope();
    const ids = await items([{ ext: `${tag}-f`, project: a, issueType: "bug", priority: 0, title: "Fields" }]);

    const board = await getWorkBoard(db, { projects: [a] });
    const c = card(board, ids.get(`${tag}-f`)!);

    expect(c).toMatchObject({ externalId: `${tag}-f`, title: "Fields", project: a, status: "open", priority: 0, issueType: "bug", assignee: null, epicId: null, closedAt: null });
    expect(c.updatedAt).toBeInstanceOf(Date);
    expect(c).not.toHaveProperty("content");
  });
});

describe("getWorkBoard lanes", () => {
  it("puts a grandchild in its epic's lane, the nearest epic of nested epics, and epic-less items in none; epics are not cards", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-outer`, project: a, issueType: "epic", title: "Outer" },
      { ext: `${tag}-inner`, project: a, issueType: "epic", title: "Inner" },
      { ext: `${tag}-feature`, project: a, issueType: "feature" },
      { ext: `${tag}-task`, project: a, issueType: "task" },
      { ext: `${tag}-deep`, project: a, issueType: "task" },
      { ext: `${tag}-loose`, project: a, issueType: "task" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("inner"), id("outer"), "child_of");
    await link(id("feature"), id("outer"), "child_of");
    await link(id("task"), id("feature"), "child_of");
    await link(id("deep"), id("inner"), "child_of");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(card(board, id("task")).epicId).toBe(id("outer"));
    expect(card(board, id("feature")).epicId).toBe(id("outer"));
    expect(card(board, id("deep")).epicId).toBe(id("inner"));
    expect(card(board, id("loose")).epicId).toBeNull();
    expect(board.cards.map((c) => c.id)).not.toContain(id("outer"));
    expect(board.cards.map((c) => c.id)).not.toContain(id("inner"));
    expect(board.epics.map((e) => e.id).sort()).toEqual([id("outer"), id("inner")].sort());
    expect(board.epics.find((e) => e.id === id("outer"))).toEqual({ id: id("outer"), title: "Outer", status: "open", project: a });
  });

  it("lists an epic with no cards, and an epic of another project that a card's lane names", async () => {
    const { a, b, tag } = scope();
    const ids = await items([
      { ext: `${tag}-empty`, project: a, issueType: "epic" },
      { ext: `${tag}-foreign`, project: b, issueType: "epic" },
      { ext: `${tag}-child`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("child"), id("foreign"), "child_of");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(board.epics.map((e) => e.id).sort()).toEqual([id("empty"), id("foreign")].sort());
    expect(card(board, id("child")).epicId).toBe(id("foreign"));
  });

  it("answers on a child_of cycle: nearest epic reached before the repeat, or none", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-p`, project: a },
      { ext: `${tag}-q`, project: a },
      { ext: `${tag}-epic`, project: a, issueType: "epic" },
      { ext: `${tag}-m`, project: a },
      { ext: `${tag}-n`, project: a },
    ]);
    const id = (x: string) => ids.get(`${tag}-${x}`)!;
    await link(id("p"), id("q"), "child_of");
    await link(id("q"), id("p"), "child_of");
    await link(id("q"), id("epic"), "child_of");
    await link(id("m"), id("n"), "child_of");
    await link(id("n"), id("m"), "child_of");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(card(board, id("p")).epicId).toBe(id("epic"));
    expect(card(board, id("q")).epicId).toBe(id("epic"));
    expect(card(board, id("m")).epicId).toBeNull();
    expect(card(board, id("n")).epicId).toBeNull();
  });
});

describe("getWorkBoard closed cap and project scoping", () => {
  it("keeps the 25 most recently closed per project and counts the rest", async () => {
    const { a, b, tag } = scope();
    const total = CLOSED_PER_PROJECT + 3;
    const specs: Spec[] = [];
    for (let i = 0; i < total; i++) {
      // i = 0 is the oldest close.
      specs.push({ ext: `${tag}-c${String(i).padStart(2, "0")}`, project: a, status: "closed", closedAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` });
    }
    specs.push({ ext: `${tag}-few`, project: b, status: "closed", closedAt: "2026-01-01T00:00:00.000Z" });
    specs.push({ ext: `${tag}-open`, project: a });
    const ids = await items(specs);

    const board = await getWorkBoard(db, { projects: [a, b] });

    const closedA = board.cards.filter((c) => c.project === a && c.column === "closed");
    expect(closedA).toHaveLength(CLOSED_PER_PROJECT);
    const keptExt = new Set(closedA.map((c) => c.externalId));
    for (let i = 3; i < total; i++) expect(keptExt.has(`${tag}-c${String(i).padStart(2, "0")}`)).toBe(true);
    for (let i = 0; i < 3; i++) expect(keptExt.has(`${tag}-c${String(i).padStart(2, "0")}`)).toBe(false);
    expect(board.omittedClosed).toEqual({ [a]: 3 });
    expect(card(board, ids.get(`${tag}-open`)!).column).toBe("ready");
    expect(card(board, ids.get(`${tag}-few`)!).column).toBe("closed");
    expect(board.truncated).toBe(false);
  });

  it("reads only the named projects, and every registered project when none is named", async () => {
    const { a, b, tag } = scope();
    await register(a, b);
    const ids = await items([
      { ext: `${tag}-in-a`, project: a },
      { ext: `${tag}-in-b`, project: b },
      { ext: `${tag}-scratch`, project: `scratch-${tag}` },
    ]);
    const inA = ids.get(`${tag}-in-a`)!;
    const inB = ids.get(`${tag}-in-b`)!;

    const onlyA = await getWorkBoard(db, { projects: [a] });
    expect(onlyA.cards.map((c) => c.id)).toEqual([inA]);

    const both = await getWorkBoard(db, { projects: [a, b] });
    expect(both.cards.map((c) => c.id).sort()).toEqual([inA, inB].sort());

    const all = await getWorkBoard(db);
    const mine = all.cards.filter((c) => c.externalId.startsWith(tag));
    expect(mine.map((c) => c.id).sort()).toEqual([inA, inB].sort());
    expect(all.cards.map((c) => c.id)).not.toContain(ids.get(`${tag}-scratch`));
  });

  it("answers an empty board for an explicit empty selection, without reading anything", async () => {
    const { a, tag } = scope();
    await register(a);
    await items([{ ext: `${tag}-x`, project: a }]);

    expect(await getWorkBoard(db, { projects: [] })).toEqual({ cards: [], epics: [], omittedClosed: {}, truncated: false });
  });

  it("ignores work items that carry no project", async () => {
    const { a, tag } = scope();
    await register(a);
    const result = await upsertNodes(db, run, [
      { nodeType: "work_item", sourceSystem: SRC, externalId: `${tag}-noproject`, title: "No project", content: "", metadata: { status: "open", priority: 2 } },
    ]);
    const id = result.rows[0]!.id;

    const all = await getWorkBoard(db);
    expect(all.cards.map((c) => c.id)).not.toContain(id);
    expect((await getWorkBoard(db, { projects: [a] })).cards).toEqual([]);
  });

  it("rejects malformed project keys before querying", async () => {
    await expect(getWorkBoard(db, { projects: ["Not A Key"] })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getWorkBoard(db, { projects: Array.from({ length: 21 }, (_, i) => `k${i}`) })).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });
});

describe("getWorkBoard cap, priority, epics, merges", () => {
  it("under the item cap, open work survives over closed rows and omittedClosed stays exact", async () => {
    const { a, tag } = scope();
    const open: Spec[] = [0, 1, 2].map((i) => ({ ext: `${tag}-o${i}`, project: a }));
    await items(open);
    const specs: Spec[] = [];
    for (let i = 0; i < CLOSED_PER_PROJECT + 2; i++) {
      specs.push({ ext: `${tag}-c${String(i).padStart(2, "0")}`, project: a, status: "closed", closedAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` });
    }
    // Written after the open items, so every closed row is more recently updated than every open one.
    await items(specs);

    const board = await getWorkBoard(db, { projects: [a], maxItems: 5 });

    expect(board.truncated).toBe(true);
    expect(board.cards).toHaveLength(5);
    expect(board.cards.filter((c) => c.column === "ready").map((c) => c.externalId).sort()).toEqual([`${tag}-o0`, `${tag}-o1`, `${tag}-o2`]);
    expect(board.cards.filter((c) => c.column === "closed")).toHaveLength(2);
    expect(board.omittedClosed).toEqual({ [a]: 2 });
  });

  it("is not truncated when the matching items fit exactly, and rejects a bad cap", async () => {
    const { a, tag } = scope();
    await items([{ ext: `${tag}-1`, project: a }, { ext: `${tag}-2`, project: a }]);
    expect((await getWorkBoard(db, { projects: [a], maxItems: 2 })).truncated).toBe(false);
    await expect(getWorkBoard(db, { projects: [a], maxItems: 0 })).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });

  it("reads a malformed stored priority as the default instead of failing the board or the readiness query", async () => {
    const { a, tag } = scope();
    const specId = `spec-${tag}`;
    const ids = await items([
      { ext: `${tag}-frac`, project: a, rawPriority: 2.5, specId },
      { ext: `${tag}-huge`, project: a, rawPriority: 1e12, specId },
      { ext: `${tag}-high`, project: a, rawPriority: 7, specId },
      { ext: `${tag}-str`, project: a, rawPriority: "1", specId },
      { ext: `${tag}-ok`, project: a, rawPriority: 0, specId },
    ]);

    const board = await getWorkBoard(db, { projects: [a] });
    expect(board.cards.map((c) => c.priority)).toEqual([0, 2, 2, 2, 2]);
    expect(board.cards[0]!.id).toBe(ids.get(`${tag}-ok`));

    const readiness = await getWorkItemReadiness(db, { specId });
    expect(readiness.ready.map((r) => r.priority).sort()).toEqual([0, 2, 2, 2, 2]);
  });

  it("drops a closed epic with no cards from the lanes, and keeps a closed epic that heads a kept card", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-dead`, project: a, issueType: "epic", status: "closed", closedAt: "2026-01-01T00:00:00.000Z" },
      { ext: `${tag}-done`, project: a, issueType: "epic", status: "closed", closedAt: "2026-01-01T00:00:00.000Z" },
      { ext: `${tag}-kid`, project: a, status: "closed", closedAt: "2026-01-02T00:00:00.000Z" },
      { ext: `${tag}-live`, project: a, issueType: "epic" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("kid"), id("done"), "child_of");

    const board = await getWorkBoard(db, { projects: [a] });

    expect(board.epics.map((e) => e.id).sort()).toEqual([id("done"), id("live")].sort());
  });

  it("folds child_of endpoints through merged_into: a merged-away epic and a merged-away child", async () => {
    const { a, tag } = scope();
    const ids = await items([
      { ext: `${tag}-epic-survivor`, project: a, issueType: "epic" },
      { ext: `${tag}-epic-loser`, project: a, issueType: "epic" },
      { ext: `${tag}-card1`, project: a },
      { ext: `${tag}-card2`, project: a },
      { ext: `${tag}-card2-dup`, project: a },
      { ext: `${tag}-epic2`, project: a, issueType: "epic" },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    // card1 -> loser epic: the destination folds onto the survivor.
    await link(id("card1"), id("epic-loser"), "child_of");
    // card2's duplicate carries the edge; card2 absorbs it, so the walk probes the alias.
    await link(id("card2-dup"), id("epic2"), "child_of");
    const mergeRun = await openIngestRun(db, SRC, { actor: "board-test-merge" });
    try {
      await mergeNodes(db, id("epic-loser"), id("epic-survivor"), mergeRun);
      await mergeNodes(db, id("card2-dup"), id("card2"), mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    const board = await getWorkBoard(db, { projects: [a] });

    expect(card(board, id("card1")).epicId).toBe(id("epic-survivor"));
    expect(card(board, id("card2")).epicId).toBe(id("epic2"));
    expect(board.cards.map((c) => c.id)).not.toContain(id("card2-dup"));
  });
});

describe("listBeadsProjects", () => {
  it("lists registry nodes by key with their path, skipping non-registry nodes", async () => {
    await upsertNodes(db, beadsRun, [
      {
        nodeType: "beads_project",
        sourceSystem: "beads",
        externalId: `project:${REGISTRY_KEY}`,
        title: REGISTRY_KEY,
        content: "",
        metadata: { project: REGISTRY_KEY, path: `/tmp/${REGISTRY_KEY}` },
      },
    ]);

    const projects = await listBeadsProjects(db);
    const mine = projects.filter((p) => p.key === REGISTRY_KEY);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ key: REGISTRY_KEY, path: `/tmp/${REGISTRY_KEY}` });
    expect(mine[0]!.updatedAt).toBeInstanceOf(Date);
  });
});

describe("getRegisteredBeadsProject", () => {
  const registryNode = (key: string, path = `/tmp/${key}`) => ({
    nodeType: "beads_project",
    sourceSystem: "beads",
    externalId: `project:${key}`,
    title: key,
    content: "",
    metadata: { project: key, path },
  });

  it("answers a registry node a beads ingest wrote", async () => {
    const key = `rgb-${SUFFIX}`;
    await register(key);
    await expect(getRegisteredBeadsProject(db, key)).resolves.toMatchObject({ key, path: `/tmp/${key}` });
  });

  it("refuses a registry-shaped node written, or last rewritten, under a non-beads run", async () => {
    // Any non-beads run stands in for brain_write's `agent` run; not `agent` itself, which apps/mcp's suite deletes when empty.
    const agentRun = await openIngestRun(db, `agent-board-test-${SUFFIX}`, { actor: "board-test" });
    extraRunIds.push(agentRun.id);
    const forged = `rga-${SUFFIX}`;
    const hijacked = `rgh-${SUFFIX}`;
    registered.push(forged);
    await register(hijacked);
    await upsertNodes(db, agentRun, [registryNode(forged, "/"), registryNode(hijacked, "/somewhere/else")]);
    await closeIngestRun(db, agentRun);

    await expect(getRegisteredBeadsProject(db, forged)).resolves.toBeNull();
    await expect(getRegisteredBeadsProject(db, hijacked)).resolves.toBeNull();
    // listBeadsProjects (the board's registry listing) is unchanged: it still lists both.
    expect((await listBeadsProjects(db)).map((p) => p.key)).toEqual(expect.arrayContaining([forged, hijacked]));
    // Its provenance-checked variant (the watcher's) lists neither, but does list a beads-written key.
    const trusted = `rgt-${SUFFIX}`;
    await register(trusted);
    const keys = (await listBeadsProjects(db, { registeredByBeads: true })).map((p) => p.key);
    expect(keys).toContain(trusted);
    expect(keys).not.toContain(forged);
    expect(keys).not.toContain(hijacked);
  });

  it("answers null for an unknown key and throws for a malformed one", async () => {
    await expect(getRegisteredBeadsProject(db, `rgn-${SUFFIX}`)).resolves.toBeNull();
    await expect(getRegisteredBeadsProject(db, "Not A Key")).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });
});

/** Writes work items with arbitrary metadata (on top of project/status/priority) in one batch; returns external id -> node id. */
async function rawItems(specs: Array<{ ext: string; project: string; title?: string; content?: string; metadata?: Record<string, unknown> }>): Promise<Map<string, string>> {
  const result = await upsertNodes(
    db,
    run,
    specs.map((s) => ({
      nodeType: "work_item",
      sourceSystem: SRC,
      externalId: s.ext,
      title: s.title ?? s.ext,
      content: s.content ?? "",
      metadata: { project: s.project, status: "open", priority: 2, ...s.metadata },
    })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

describe("getWorkBoard review flag", () => {
  it("marks a card a review only for the exact label 'review' in a labels array", async () => {
    const { a, tag } = scope();
    const ids = await rawItems([
      { ext: `${tag}-review`, project: a, metadata: { labels: ["ui", "review"] } },
      { ext: `${tag}-changes`, project: a, metadata: { labels: ["review:changes"] } },
      { ext: `${tag}-string`, project: a, metadata: { labels: "review" } },
      { ext: `${tag}-plain`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;

    const board = await getWorkBoard(db, { projects: [a] });

    expect(card(board, id("review")).review).toBe(true);
    expect(card(board, id("changes")).review).toBe(false);
    expect(card(board, id("string")).review).toBe(false);
    expect(card(board, id("plain")).review).toBe(false);
  });
});

describe("getBoardItem", () => {
  const images = ["/home/u/.local/share/breakdown/reviews/p/r1/01-a.png", "/home/u/.local/share/breakdown/reviews/p/r1/02-b.png"];
  const comments = [
    { id: "1", author: "agent", text: "requested", created_at: "2026-10-28T10:00:00.000Z" },
    { id: "2", author: "caleb", text: "Changes requested: overlap", created_at: "2026-10-28T11:00:00.000Z" },
  ];

  it("reads a review item's details, source system, review, and comments", async () => {
    const { a, tag } = scope();
    const ids = await rawItems([
      {
        ext: `${tag}-r1`,
        project: a,
        title: "Review: board header",
        content: "Look at it.",
        metadata: {
          issue_type: "task",
          assignee: "caleb",
          labels: ["review", "review:changes"],
          review: { images, pane: "w1:p2", summary: "Board header" },
          review_comments: comments,
        },
      },
    ]);

    const item = await getBoardItem(db, { project: a, externalId: `${tag}-r1` });

    expect(item).toMatchObject({
      id: ids.get(`${tag}-r1`),
      externalId: `${tag}-r1`,
      sourceSystem: SRC,
      project: a,
      title: "Review: board header",
      content: "Look at it.",
      status: "open",
      priority: 2,
      issueType: "task",
      assignee: "caleb",
      labels: ["review", "review:changes"],
      closedAt: null,
      closedReason: null,
      isReview: true,
      review: { images, pane: "w1:p2", summary: "Board header" },
      comments,
    });
    expect(item?.updatedAt).toBeInstanceOf(Date);
  });

  it("answers review null for a plain item, null for another project, the survivor for a merged-away id, and invalid for a malformed review", async () => {
    const { a, b, tag } = scope();
    const ids = await rawItems([
      { ext: `${tag}-plain`, project: a, metadata: { labels: ["ui"], review: { summary: "ignored on a non-review" }, review_comments: comments } },
      { ext: `${tag}-nullreview`, project: a, metadata: { labels: ["review"], review: null } },
      { ext: `${tag}-bad`, project: a, metadata: { labels: ["review"], review: { images: "a.png" } } },
      { ext: `${tag}-stored-invalid`, project: a, metadata: { labels: ["review"], review: { invalid: true } } },
      { ext: `${tag}-nometa`, project: a, metadata: { labels: ["review"] } },
      { ext: `${tag}-survivor`, project: a },
      { ext: `${tag}-loser`, project: a },
    ]);
    const mergeRun = await openIngestRun(db, SRC, { actor: "board-test-merge" });
    try {
      await mergeNodes(db, ids.get(`${tag}-loser`)!, ids.get(`${tag}-survivor`)!, mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    expect(await getBoardItem(db, { project: a, externalId: `${tag}-plain` })).toMatchObject({ isReview: false, review: null, comments: [], labels: ["ui"] });
    expect(await getBoardItem(db, { project: b, externalId: `${tag}-plain` })).toBeNull();
    expect(await getBoardItem(db, { project: a, externalId: `${tag}-loser` })).toMatchObject({ id: ids.get(`${tag}-survivor`), externalId: `${tag}-survivor` });
    expect(await getBoardItem(db, { project: b, externalId: `${tag}-loser` })).toBeNull();
    expect(await getBoardItem(db, { project: a, externalId: `${tag}-survivor` })).toMatchObject({ id: ids.get(`${tag}-survivor`) });
    expect(await getBoardItem(db, { project: a, externalId: `${tag}-nullreview` })).toMatchObject({ isReview: true, review: null });
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-bad` }))?.review).toEqual({ invalid: true });
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-stored-invalid` }))?.review).toEqual({ invalid: true });
    expect(await getBoardItem(db, { project: a, externalId: `${tag}-nometa` })).toMatchObject({ isReview: true, review: null, comments: [] });
  });

  it("answers null for a bead merged into another project's node or a project-less one", async () => {
    const { a, b, tag } = scope();
    const ids = await rawItems([
      { ext: `${tag}-crossloser`, project: a, metadata: { labels: ["review"] } },
      { ext: `${tag}-crosssurvivor`, project: b },
      { ext: `${tag}-orphanloser`, project: a },
    ]);
    const bare = await upsertNodes(db, run, [{ nodeType: "work_item", sourceSystem: SRC, externalId: `${tag}-bare`, title: "bare", content: "", metadata: { status: "open", priority: 2 } }]);
    const mergeRun = await openIngestRun(db, SRC, { actor: "board-test-merge" });
    try {
      await mergeNodes(db, ids.get(`${tag}-crossloser`)!, ids.get(`${tag}-crosssurvivor`)!, mergeRun);
      await mergeNodes(db, ids.get(`${tag}-orphanloser`)!, bare.rows[0]!.id, mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    expect(await getBoardItem(db, { project: a, externalId: `${tag}-crossloser` })).toBeNull();
    expect(await getBoardItem(db, { project: a, externalId: `${tag}-orphanloser` })).toBeNull();
    expect(await getBoardItem(db, { project: b, externalId: `${tag}-crosssurvivor` })).toMatchObject({ id: ids.get(`${tag}-crosssurvivor`), project: b });
  });

  it("names the item's child_of parent in its project, folded through merges, and null otherwise", async () => {
    const { a, b, tag } = scope();
    const ids = await rawItems([
      { ext: `${tag}-epic`, project: a, title: "The epic", metadata: { issue_type: "epic" } },
      { ext: `${tag}-child`, project: a },
      { ext: `${tag}-orphan`, project: a },
      { ext: `${tag}-crosschild`, project: a },
      { ext: `${tag}-foreign`, project: b },
      { ext: `${tag}-oldparent`, project: a },
      { ext: `${tag}-newparent`, project: a, title: "Survivor parent" },
      { ext: `${tag}-viaold`, project: a },
      { ext: `${tag}-aliaschild`, project: a },
      { ext: `${tag}-aliassurvivor`, project: a },
      { ext: `${tag}-selfchild`, project: a },
      { ext: `${tag}-selfparent`, project: a },
    ]);
    const id = (n: string) => ids.get(`${tag}-${n}`)!;
    await link(id("child"), id("epic"), "child_of");
    await link(id("crosschild"), id("foreign"), "child_of");
    await link(id("viaold"), id("oldparent"), "child_of");
    await link(id("aliaschild"), id("epic"), "child_of");
    await link(id("selfchild"), id("selfparent"), "child_of");
    const mergeRun = await openIngestRun(db, SRC, { actor: "board-test-merge" });
    try {
      await mergeNodes(db, id("oldparent"), id("newparent"), mergeRun);
      await mergeNodes(db, id("aliaschild"), id("aliassurvivor"), mergeRun);
      await mergeNodes(db, id("selfparent"), id("selfchild"), mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    expect((await getBoardItem(db, { project: a, externalId: `${tag}-child` }))?.parent).toEqual({ externalId: `${tag}-epic`, title: "The epic" });
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-orphan` }))?.parent).toBeNull();
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-crosschild` }))?.parent).toBeNull();
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-viaold` }))?.parent).toEqual({ externalId: `${tag}-newparent`, title: "Survivor parent" });
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-aliassurvivor` }))?.parent).toEqual({ externalId: `${tag}-epic`, title: "The epic" });
    expect((await getBoardItem(db, { project: a, externalId: `${tag}-selfchild` }))?.parent).toBeNull();
  });

  it("refuses a malformed project key or item id", async () => {
    await expect(getBoardItem(db, { project: "Not A Key", externalId: "x" })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getBoardItem(db, { project: "ok", externalId: "" })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    await expect(getBoardItem(db, { project: "ok", externalId: "x".repeat(201) })).rejects.toBeInstanceOf(InvalidLookupOptionError);
  });
});
