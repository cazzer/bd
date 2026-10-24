// Caller tests for the live board procedures (live-beads-board 3.4). No
// database: the watcher is built with injected ingest/registry seams and
// `db` is never touched.

import { describe, expect, it } from "vitest";
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
    ingest: (_db, o) => ingest(o.project),
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
});
