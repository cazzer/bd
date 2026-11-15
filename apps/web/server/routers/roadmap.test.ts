// roadmap-milestones, tasks.md 2.4: the `roadmap` procedure through the real
// router chain (Zod -> packages/core -> response). packages/core's
// roadmap.test.ts proves the read itself and is trusted, not re-proven,
// here. Fixtures carry this file's own source system and unique project
// keys; nothing asserts a store-wide count.

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, upsertEdges, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const SRC = `roadmap-router-test-${TAG}`;
const PROJECT = `rm-${TAG}`;
const OTHER = `rn-${TAG}`;

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, SRC, { actor: "roadmap-router-suite" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
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

describe("roadmap", () => {
  it("returns the chosen project's milestones and epics with progress as wire-safe JSON, without content", async () => {
    const written = await upsertNodes(
      db,
      run,
      [
        { ext: `${TAG}-m`, project: PROJECT, issue_type: "milestone", due_at: "2026-12-15T00:00:00.000Z" },
        { ext: `${TAG}-e`, project: PROJECT, issue_type: "epic" },
        { ext: `${TAG}-t`, project: PROJECT, status: "closed", started_at: "2026-11-01T00:00:00.000Z" },
        { ext: `${TAG}-other`, project: OTHER, issue_type: "epic" },
      ].map(({ ext, ...metadata }) => ({
        nodeType: "work_item",
        sourceSystem: SRC,
        externalId: ext,
        title: ext,
        content: "must never reach the roadmap",
        metadata: { status: "open", priority: 2, ...metadata },
      })),
    );
    const id = new Map(written.rows.map((r) => [r.externalId, r.id]));
    await upsertEdges(db, run, [
      { srcId: id.get(`${TAG}-e`)!, dstId: id.get(`${TAG}-m`)!, edgeType: "child_of", sourceSystem: SRC },
      { srcId: id.get(`${TAG}-t`)!, dstId: id.get(`${TAG}-e`)!, edgeType: "child_of", sourceSystem: SRC },
    ]);

    const roadmap = await caller().roadmap({ projects: [PROJECT] });

    expect(roadmap.milestones).toEqual([
      {
        id: id.get(`${TAG}-m`),
        externalId: `${TAG}-m`,
        title: `${TAG}-m`,
        status: "open",
        project: PROJECT,
        dueAt: "2026-12-15T00:00:00.000Z",
        progress: { total: 1, closed: 1, inProgress: 0, deferred: 0, open: 0 },
        unepicked: { total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0 },
      },
    ]);
    expect(roadmap.epics).toEqual([
      {
        id: id.get(`${TAG}-e`),
        externalId: `${TAG}-e`,
        title: `${TAG}-e`,
        status: "open",
        project: PROJECT,
        milestoneId: id.get(`${TAG}-m`),
        dueAt: null,
        startedAt: null,
        closedAt: null,
        firstStartedAt: "2026-11-01T00:00:00.000Z",
        progress: { total: 1, closed: 1, inProgress: 0, deferred: 0, open: 0 },
      },
    ]);
    expect(roadmap.truncated).toBe(false);
    expect(JSON.stringify(roadmap)).not.toContain("must never reach");
    expect(JSON.parse(JSON.stringify(roadmap))).toEqual(roadmap);
  });

  it("answers an empty roadmap for an empty project list", async () => {
    expect(await caller().roadmap({ projects: [] })).toEqual({ milestones: [], epics: [], truncated: false });
  });

  it("refuses an uppercase project key naming projects, before touching the database", async () => {
    const poisoned = caller({ db: poisonedDb() });
    const err = await poisoned.roadmap({ projects: ["Tides"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect(String((err as Error).message)).toContain("projects");
    await expect(poisoned.roadmap({ projects: Array.from({ length: 21 }, (_, i) => `k${i}`) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
