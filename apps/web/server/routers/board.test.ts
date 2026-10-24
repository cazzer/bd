// live-beads-board, tasks.md 2.4: the `board` and `beadsProjects` procedures
// through the real router chain (Zod -> packages/core -> DTO -> response
// budget). packages/core/src/board.test.ts proves the read itself and is
// trusted, not re-proven, here. Fixtures carry this file's own source system
// and unique project keys; nothing asserts a store-wide count.

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, upsertEdges, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;
let beadsRun: IngestRunHandle;

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const SRC = `board-router-test-${TAG}`;
const PROJECT = `rt-${TAG}`;
const OTHER = `ro-${TAG}`;
const REGISTRY_KEY = `rreg-${TAG}`;

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, SRC, { actor: "board-router-suite" });
  beadsRun = await openIngestRun(db, "beads", { actor: "board-router-suite" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await closeIngestRun(db, beadsRun);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, [`project:${REGISTRY_KEY}`, `project:${OTHER}`])));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id, beadsRun.id]));
  await pool.end();
});

const createCaller = createCallerFactory(appRouter);

function caller(extra: Partial<Context> = {}) {
  return createCaller({ db, ...extra });
}

/** Throws on any property access — proves Zod rejected the call before the resolver ran. */
function poisonedDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("ctx.db should never be touched for a request rejected by validation before any database call");
      },
    },
  ) as Database;
}

async function writeItems(specs: Array<{ ext: string; project: string; status?: string; issueType?: string }>): Promise<Map<string, string>> {
  const result = await upsertNodes(
    db,
    run,
    specs.map((s) => ({
      nodeType: "work_item",
      sourceSystem: SRC,
      externalId: s.ext,
      title: s.ext,
      content: "must never reach the board",
      metadata: { project: s.project, status: s.status ?? "open", priority: 2, ...(s.issueType ? { issue_type: s.issueType } : {}) },
    })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

describe("board", () => {
  it("returns the chosen projects' cards with column, epic, and blockers as wire-safe JSON, without content", async () => {
    const ids = await writeItems([
      { ext: `${TAG}-epic`, project: PROJECT, issueType: "epic" },
      { ext: `${TAG}-child`, project: PROJECT },
      { ext: `${TAG}-blocker`, project: OTHER, status: "in_progress" },
      { ext: `${TAG}-elsewhere`, project: OTHER },
    ]);
    const id = (n: string) => ids.get(`${TAG}-${n}`)!;
    await upsertEdges(db, run, [
      { srcId: id("child"), dstId: id("epic"), edgeType: "child_of", sourceSystem: SRC },
      { srcId: id("blocker"), dstId: id("child"), edgeType: "blocks", sourceSystem: SRC },
    ]);

    const board = await caller().board({ projects: [PROJECT] });

    expect(board.cards.map((c) => c.id)).toEqual([id("child")]);
    const c = board.cards[0]!;
    expect(c).toMatchObject({ column: "blocked", epicId: id("epic"), openBlockerIds: [id("blocker")], blockedFlag: true, project: PROJECT });
    expect(typeof c.updatedAt).toBe("string");
    expect(c).not.toHaveProperty("content");
    expect(board.epics.map((e) => e.id)).toEqual([id("epic")]);
    expect(board.omittedClosed).toEqual({});
    expect(board.truncated).toBe(false);
    expect(board.droppedCardIds).toEqual([]);
    expect(JSON.parse(JSON.stringify(board))).toEqual(board);
  });

  it("reads every registered project when none is named, and nothing for an empty list", async () => {
    await upsertNodes(db, beadsRun, [
      { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${OTHER}`, title: OTHER, content: "", metadata: { project: OTHER, path: `/tmp/${OTHER}` } },
    ]);
    const ids = await writeItems([
      { ext: `${TAG}-any`, project: OTHER },
      { ext: `${TAG}-scratch`, project: `scratch-${TAG}` },
    ]);

    const board = await caller().board({});
    expect(board.cards.map((c) => c.id)).toContain(ids.get(`${TAG}-any`));
    expect(board.cards.map((c) => c.id)).not.toContain(ids.get(`${TAG}-scratch`));

    const none = await caller().board({ projects: [] });
    expect(none).toEqual({ cards: [], epics: [], omittedClosed: {}, truncated: false, droppedCardIds: [] });
  });

  it("is bounded: a tiny response budget drops cards from the tail and says so", async () => {
    await writeItems(Array.from({ length: 6 }, (_, i) => ({ ext: `${TAG}-bulk-${i}`, project: `rb-${TAG}` })));

    const board = await caller({ responseCharBudget: 1500 }).board({ projects: [`rb-${TAG}`] });

    expect(board.cards.length).toBeGreaterThanOrEqual(1);
    expect(board.cards.length).toBeLessThan(6);
    expect(board.truncated).toBe(true);
    expect(board.droppedCardIds.length).toBe(6 - board.cards.length);
  });

  it("rejects a malformed or oversized project list before touching the database", async () => {
    const poisoned = caller({ db: poisonedDb() });
    await expect(poisoned.board({ projects: ["Not A Key"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.board({ projects: Array.from({ length: 21 }, (_, i) => `k${i}`) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.board({ projects: [""] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("beadsProjects", () => {
  it("lists registered projects with ISO timestamps", async () => {
    await upsertNodes(db, beadsRun, [
      { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${REGISTRY_KEY}`, title: REGISTRY_KEY, content: "", metadata: { project: REGISTRY_KEY, path: `/tmp/${REGISTRY_KEY}` } },
    ]);

    const { projects } = await caller().beadsProjects();
    const mine = projects.find((p) => p.key === REGISTRY_KEY);

    expect(mine).toMatchObject({ key: REGISTRY_KEY, path: `/tmp/${REGISTRY_KEY}` });
    expect(typeof mine?.updatedAt).toBe("string");
  });

  it("joins each project's last-ingest outcome from the watcher, null when none", async () => {
    const at = "2026-10-24T10:00:00.000Z";
    const watcher = {
      outcomes: () => [{ project: REGISTRY_KEY, ok: false as const, at, error: "bd list failed" }],
    } as unknown as NonNullable<Context["watcher"]>;
    await upsertNodes(db, beadsRun, [
      { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${OTHER}`, title: OTHER, content: "", metadata: { project: OTHER, path: `/tmp/${OTHER}` } },
      { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${REGISTRY_KEY}`, title: REGISTRY_KEY, content: "", metadata: { project: REGISTRY_KEY, path: `/tmp/${REGISTRY_KEY}` } },
    ]);

    const withWatcher = (await caller({ watcher }).beadsProjects()).projects;
    expect(withWatcher.find((p) => p.key === REGISTRY_KEY)?.lastIngest).toEqual({ ok: false, at, error: "bd list failed" });
    expect(withWatcher.find((p) => p.key === OTHER)?.lastIngest).toBeNull();

    const without = (await caller().beadsProjects()).projects;
    expect(without.find((p) => p.key === REGISTRY_KEY)?.lastIngest).toBeNull();
  });
});
