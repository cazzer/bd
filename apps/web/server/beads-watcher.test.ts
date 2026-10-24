// Watcher tests (live-beads-board 3.2): no database, no real `bd`, no real
// time. The scheduler runs against vitest fake timers and a hand-resolved
// `load`; fingerprints run against temp dirs; the watcher is driven through
// injected `ingest`, `readRegistry`, and `watchDir` seams.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BEADS_WATCHER_EVENT,
  createBeadsWatcher,
  createProjectScheduler,
  DEBOUNCE_MS,
  fingerprintCheckout,
  SAFETY_TICK_MS,
  type BeadsWatcherEvent,
  type LoadResult,
} from "./beads-watcher.js";

const RESULT = (over: Partial<LoadResult> = {}): LoadResult => ({
  changed: false,
  changedNodeIds: [],
  nodes: { created: 0, updated: 0, unchanged: 3 },
  edges: { created: 0, updated: 2 },
  ...over,
});

/** A load whose completion the test controls. */
function deferredLoad() {
  const calls: Array<{ resolve: (r: LoadResult) => void; reject: (e: Error) => void }> = [];
  const load = vi.fn(
    () =>
      new Promise<LoadResult>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { load, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fingerprintCheckout", () => {
  let dir: string;
  const noms = () => path.join(dir, ".beads", "embeddeddolt", "db1", ".dolt", "noms");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fp-"));
    mkdirSync(noms(), { recursive: true });
    writeFileSync(path.join(noms(), "manifest"), "m1");
    writeFileSync(path.join(noms(), "journal.idx"), "abcd");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable across an mtime bump (what `bd list` does)", () => {
    const before = fingerprintCheckout(dir);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const t = new Date(Date.now() + 60_000);
    utimesSync(path.join(noms(), "manifest"), t, t);
    utimesSync(path.join(noms(), "journal.idx"), t, t);
    expect(fingerprintCheckout(dir)).toBe(before);
  });

  it("changes when the manifest content changes", () => {
    const before = fingerprintCheckout(dir);
    writeFileSync(path.join(noms(), "manifest"), "m2");
    expect(fingerprintCheckout(dir)).not.toBe(before);
  });

  it("changes when journal.idx changes size", () => {
    const before = fingerprintCheckout(dir);
    writeFileSync(path.join(noms(), "journal.idx"), "abcdef");
    expect(fingerprintCheckout(dir)).not.toBe(before);
  });

  it("is null when the manifest, journal.idx, or the layout is missing", () => {
    rmSync(path.join(noms(), "journal.idx"));
    expect(fingerprintCheckout(dir)).toBeNull();
    writeFileSync(path.join(noms(), "journal.idx"), "abcd");
    rmSync(path.join(noms(), "manifest"));
    expect(fingerprintCheckout(dir)).toBeNull();
    expect(fingerprintCheckout(path.join(dir, "nowhere"))).toBeNull();
  });
});

describe("project scheduler", () => {
  function make(fingerprint: () => string | null, load: () => Promise<LoadResult>) {
    const outcomes: Array<{ ok: boolean }> = [];
    const scheduler = createProjectScheduler({
      project: "p",
      fingerprint,
      load,
      onOutcome: (o) => outcomes.push(o),
    });
    return { scheduler, outcomes };
  }

  it("skips a wake whose fingerprint equals the last loaded one", async () => {
    const load = vi.fn(async () => RESULT());
    const { scheduler } = make(() => "A", load);
    await scheduler.loadNow();
    expect(load).toHaveBeenCalledTimes(1);

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads once when the fingerprint changed", async () => {
    let fp = "A";
    const load = vi.fn(async () => RESULT());
    const { scheduler } = make(() => fp, load);
    await scheduler.loadNow();

    fp = "B";
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("debounces a burst of wakes into a single load", async () => {
    let fp = "A";
    const load = vi.fn(async () => RESULT());
    const { scheduler } = make(() => fp, load);
    await scheduler.loadNow();

    fp = "B";
    for (let i = 0; i < 20; i++) {
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 4);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a burst spanning a load yields at most two loads", async () => {
    let fp = "A";
    const { load, calls } = deferredLoad();
    const { scheduler } = make(() => fp, load);
    const first = scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.resolve(RESULT());
    await first;
    expect(load).toHaveBeenCalledTimes(1);

    fp = "B";
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2); // in flight
    for (let i = 0; i < 10; i++) scheduler.wake(); // burst during the load
    fp = "C";
    calls[1]!.resolve(RESULT());
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(3); // exactly one follow-up
    calls[2]!.resolve(RESULT());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 5);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("a wake during a load yields exactly one follow-up", async () => {
    let fp = "A";
    const { load, calls } = deferredLoad();
    const { scheduler } = make(() => fp, load);
    const first = scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.wake();
    scheduler.wake();
    fp = "B"; // a write landed mid-load
    calls[0]!.resolve(RESULT());
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(RESULT());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 5);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a null fingerprint always loads", async () => {
    const load = vi.fn(async () => RESULT());
    const onNull = vi.fn();
    const scheduler = createProjectScheduler({ project: "p", fingerprint: () => null, load, onOutcome: () => {}, onNullFingerprint: onNull });
    await scheduler.loadNow();
    for (let i = 0; i < 3; i++) {
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    }
    expect(load).toHaveBeenCalledTimes(4);
    expect(onNull).toHaveBeenCalledTimes(1);
  });

  it("a failed load keeps the old fingerprint so the next wake retries", async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error("bd exploded");
      return RESULT();
    });
    const { scheduler, outcomes } = make(() => "A", load);
    const o = await scheduler.loadNow();
    expect(o).toMatchObject({ ok: false, error: "bd exploded" });

    fail = false;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);
    expect(outcomes.map((x) => x.ok)).toEqual([false, true]);
  });

  it("stop() awaits an in-flight load and cancels a pending debounce", async () => {
    let fp = "A";
    const { load, calls } = deferredLoad();
    const { scheduler } = make(() => fp, load);
    const first = scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);

    calls[0]!.resolve(RESULT());
    await stopping;
    expect(stopped).toBe(true);
    await first;

    fp = "B";
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("beads watcher", () => {
  function setup(opts: { ingest: (project: string) => Promise<LoadResult>; registry?: Array<{ project: string; dir: string }> }) {
    const registry = opts.registry ?? [
      { project: "a", dir: "/x/a" },
      { project: "b", dir: "/x/b" },
    ];
    const wakes = new Map<string, () => void>();
    const closed: string[] = [];
    const watcher = createBeadsWatcher({
      db: {} as never,
      ingest: (_db, o) => opts.ingest(o.project),
      readRegistry: async () => registry,
      watchDir: (dir, onWake) => {
        wakes.set(dir, onWake);
        return { close: () => closed.push(dir) };
      },
      fingerprint: (dir) => `fp:${dir}`,
      log: () => {},
    });
    const events: BeadsWatcherEvent[] = [];
    watcher.events.on(BEADS_WATCHER_EVENT, (e: BeadsWatcherEvent) => events.push(e));
    return { watcher, events, wakes, closed, registry };
  }

  it("emits changed only when the load's changed flag is set", async () => {
    const { watcher, events } = setup({
      ingest: async (p) => (p === "a" ? RESULT({ changed: true, changedNodeIds: ["n1"] }) : RESULT({ changed: false })),
    });
    const outcomes = await watcher.reload();
    expect(outcomes).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "changed", project: "a", changedNodeIds: ["n1"] });
    expect(typeof (events[0] as { at: string }).at).toBe("string");
    await watcher.stop();
  });

  it("one project's failure does not block another and is reported", async () => {
    const { watcher, events } = setup({
      ingest: async (p) => {
        if (p === "a") throw new Error("bd failed");
        return RESULT({ changed: true, changedNodeIds: ["n2"] });
      },
    });
    const outcomes = await watcher.reload();
    expect(outcomes.find((o) => o.project === "a")).toMatchObject({ ok: false, error: "bd failed" });
    expect(outcomes.find((o) => o.project === "b")).toMatchObject({ ok: true });
    expect(events.map((e) => e.kind).sort()).toEqual(["changed", "error"]);
    expect(watcher.outcomes()).toHaveLength(2);
    await watcher.stop();
  });

  it("start() loads every project and the tick wakes them without loading on an equal fingerprint", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher } = setup({ ingest });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS + DEBOUNCE_MS + 10);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("reload() picks up a project registered after start and drops a removed one", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, registry, closed } = setup({ ingest });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    registry.splice(0, registry.length, { project: "b", dir: "/x/b" }, { project: "c", dir: "/x/c" });
    const outcomes = await watcher.reload();
    expect(outcomes.map((o) => o.project).sort()).toEqual(["b", "c"]);
    expect(closed).toContain("/x/a/.beads");
    expect(watcher.outcomes().map((o) => o.project).sort()).toEqual(["b", "c"]);
    await watcher.stop();
  });

  it("an fs wake on a watched dir does not load while the fingerprint is unchanged", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, wakes } = setup({ ingest });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    wakes.get("/x/a/.beads")!();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("stop() closes watchers and the tick, and awaits an in-flight load", async () => {
    let release!: () => void;
    const ingest = vi.fn(
      () =>
        new Promise<LoadResult>((resolve) => {
          release = () => resolve(RESULT());
        }),
    );
    const { watcher, closed } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    let done = false;
    const stopping = watcher.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS * 2);
    expect(done).toBe(false);
    expect(closed).toContain("/x/a/.beads");
    release();
    await stopping;
    expect(done).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
