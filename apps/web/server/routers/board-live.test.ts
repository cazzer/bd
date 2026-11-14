// Caller tests for the live board procedures (live-beads-board 3.4). The
// watcher is built with injected ingest/registry seams; only the queue-mode
// refresh (no `bd`; laptop-relay decision 6) touches the database, inside a
// transaction that is rolled back, since it queues for every registered
// project: nothing it writes outlives the test or reaches a relay.

import { randomUUID } from "node:crypto";
import { getRelayAction, openIngestRun, upsertNodes } from "@breakdown/core";
import { createDb, createPool, relayActions, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BEADS_WATCHER_EVENT, createBeadsWatcher, type BeadsWatcherEvent, type LoadResult } from "../beads-watcher.js";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

const createCaller = createCallerFactory(appRouter);

const RESULT = (over: Partial<LoadResult> = {}): LoadResult => ({
  changed: false,
  changedNodeIds: [],
  nodes: { created: 1, updated: 2, unchanged: 3 },
  edges: { created: 0, updated: 4 },
  ...over,
});

function watcherWith(ingest: (project: string) => Promise<LoadResult>) {
  return createBeadsWatcher({
    db: {} as never,
    ingest: (o) => ingest(o.project),
    readRegistry: async () => [
      { project: "ok", dir: "/nowhere/ok" },
      { project: "bad", dir: "/nowhere/bad" },
    ],
    watchDir: () => ({ close() {} }),
    log: () => {},
  });
}

describe("boardEvents", () => {
  it("delivers an emitted event to a subscriber and ends when the request aborts", async () => {
    const watcher = watcherWith(async () => RESULT());
    const abort = new AbortController();
    const caller = createCaller({ db: {} as never, watcher } satisfies Context, { signal: abort.signal });
    const iterable = await caller.boardEvents();
    const iterator = iterable[Symbol.asyncIterator]();

    const next = iterator.next();
    const event: BeadsWatcherEvent = { kind: "changed", project: "ok", changedNodeIds: ["n1"], at: "2026-01-01T00:00:00.000Z" };
    // The generator attaches its listener on the first pull; give it a tick.
    await new Promise((r) => setImmediate(r));
    watcher.events.emit(BEADS_WATCHER_EVENT, event);
    expect((await next).value).toEqual(event);

    const ended = iterator.next();
    abort.abort();
    expect((await ended).done).toBe(true);
  });

  it("ends when the server-wide shutdown signal aborts", async () => {
    const watcher = watcherWith(async () => RESULT());
    const shutdown = new AbortController();
    const caller = createCaller({ db: {} as never, watcher, shutdownSignal: shutdown.signal });
    const iterator = (await caller.boardEvents())[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((r) => setImmediate(r));
    shutdown.abort();
    expect((await pending).done).toBe(true);
  });

  it("fails clearly when no watcher is configured", async () => {
    const caller = createCaller({ db: {} as never });
    await expect(
      (async () => {
        const it = (await caller.boardEvents())[Symbol.asyncIterator]();
        await it.next();
      })(),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("streams without bd on PATH: an inert watcher's recorded (relay-pushed) load reaches the subscriber", async () => {
    const watcher = createBeadsWatcher({ db: {} as never, bdAvailable: false, log: () => {} });
    await watcher.start();
    const abort = new AbortController();
    const caller = createCaller({ db: {} as never, watcher, missingBinaries: ["bd"] }, { signal: abort.signal });
    const iterator = (await caller.boardEvents())[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise((r) => setImmediate(r));
    const result = RESULT({ changed: true, changedNodeIds: ["n7"] });
    watcher.record("pushed", { ok: true, changed: true, nodes: result.nodes, edges: result.edges, at: "2026-01-01T00:00:00.000Z" }, result);
    expect((await next).value).toEqual({ kind: "changed", project: "pushed", changedNodeIds: ["n7"], at: "2026-01-01T00:00:00.000Z" });
    abort.abort();
    await watcher.stop();
  });
});

describe("refreshBoard", () => {
  it("reports per-project counts and errors", async () => {
    const watcher = watcherWith(async (project) => {
      if (project === "bad") throw new Error("bd failed");
      return RESULT();
    });
    const caller = createCaller({ db: {} as never, watcher });
    const result = await caller.refreshBoard();
    expect(result.find((r) => r.project === "ok")).toEqual({
      project: "ok",
      ok: true,
      nodes: { created: 1, updated: 2, unchanged: 3 },
      edges: { created: 0, updated: 4 },
    });
    expect(result.find((r) => r.project === "bad")).toEqual({ project: "bad", ok: false, error: "bd failed" });
    await watcher.stop();
  });

  it("fails clearly when no watcher is configured", async () => {
    await expect(createCaller({ db: {} as never }).refreshBoard()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("runs the watcher's loads and queues nothing when bd is on PATH", async () => {
    const watcher = watcherWith(async () => RESULT());
    const result = await createCaller({ db: {} as never, watcher }).refreshBoard();
    expect(result.every((r) => !("queued" in r))).toBe(true);
    await watcher.stop();
  });

  it("still refreshes when only herdr is missing", async () => {
    const watcher = watcherWith(async () => RESULT());
    const caller = createCaller({ db: {} as never, watcher, missingBinaries: ["herdr"] });
    expect(await caller.refreshBoard()).toHaveLength(2);
    await watcher.stop();
  });
});

describe("refreshBoard without bd on PATH (queued for the laptop relay)", () => {
  const TAG = randomUUID().slice(0, 8);
  const PROJECT = `blq-${TAG}`;
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(() => {
    pool = createPool(resolveDatabaseUrl());
    db = createDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Runs `body` in a transaction that is always rolled back: refresh queues for every registered project, so nothing it queues may outlive the test. */
  async function rolledBack(body: (tx: Database) => Promise<void>): Promise<void> {
    const ROLLBACK = new Error("rollback");
    await db
      .transaction(async (tx) => {
        await body(tx as unknown as Database);
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
  }

  it("queues one beads_reingest per registered project, reports its id, folds a repeat into it, and runs no load", async () => {
    let ingested = 0;
    const watcher = watcherWith(async () => (ingested++, RESULT()));
    await rolledBack(async (tx) => {
      const run = await openIngestRun(tx, "beads", { actor: `board-live-suite-${TAG}` });
      await upsertNodes(tx, run, [
        { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${PROJECT}`, title: PROJECT, content: "", metadata: { project: PROJECT, path: `/Users/someone/${PROJECT}` } },
      ]);
      const caller = createCaller({ db: tx, watcher, missingBinaries: ["bd"] });

      const first = await caller.refreshBoard();
      const mine = first.find((r) => r.project === PROJECT);
      expect(mine).toEqual({ project: PROJECT, ok: true, queued: expect.any(Number) });
      const actionId = (mine as { queued: number }).queued;
      expect(await getRelayAction(tx, actionId)).toMatchObject({ kind: "beads_reingest", state: "queued", payload: { project_key: PROJECT }, requestedBy: "human" });

      const again = await caller.refreshBoard();
      expect(again.find((r) => r.project === PROJECT)).toEqual({ project: PROJECT, ok: true, queued: actionId });
    });
    expect(ingested).toBe(0);
    // The transaction took the actions with it.
    expect(await db.select({ id: relayActions.id }).from(relayActions).where(sql`${relayActions.payload}->>'project_key' = ${PROJECT}`)).toEqual([]);
    await watcher.stop();
  });
});
