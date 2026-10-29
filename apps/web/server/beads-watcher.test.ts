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

  it("debounces: nothing loads before DEBOUNCE_MS, then a burst of wakes yields a single load", async () => {
    let n = 0;
    const load = vi.fn(async () => RESULT());
    const { scheduler } = make(() => `fp${n}`, load);
    await scheduler.loadNow();
    load.mockClear();

    for (let i = 0; i < 5; i++) {
      n++; // a different fingerprint on every wake, so only the debounce can coalesce them
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 5 * 10 - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a continuous burst does not defer the load past one debounce window", async () => {
    let n = 0;
    const load = vi.fn(async () => RESULT());
    const { scheduler } = make(() => `fp${n}`, load);
    await scheduler.loadNow();
    load.mockClear();

    for (let t = 0; t < 2000; t += 100) {
      n++;
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(100);
      if (t === DEBOUNCE_MS + 100) expect(load).toHaveBeenCalled();
    }
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  it("a null fingerprint: fs wakes are ignored, only the tick (and loadNow) loads", async () => {
    const load = vi.fn(async () => RESULT());
    const onNull = vi.fn();
    const scheduler = createProjectScheduler({ project: "p", fingerprint: () => null, load, onOutcome: () => {}, onNullFingerprint: onNull });
    await scheduler.loadNow();
    for (let i = 0; i < 3; i++) {
      scheduler.wake();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    }
    expect(load).toHaveBeenCalledTimes(1);
    scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onNull).toHaveBeenCalledTimes(1);
  });

  it("a null-fingerprint load that is woken by its own bd does not loop", async () => {
    const holder: { scheduler?: ReturnType<typeof createProjectScheduler> } = {};
    const load = vi.fn(async () => {
      for (let i = 0; i < 40; i++) holder.scheduler!.wake(); // ~39 fs events from our own `bd list`
      await vi.advanceTimersByTimeAsync(0);
      return RESULT();
    });
    holder.scheduler = createProjectScheduler({ project: "p", fingerprint: () => null, load, onOutcome: () => {} });
    await holder.scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a failing load that is woken by its own bd does not loop; the tick retries it", async () => {
    const holder: { scheduler?: ReturnType<typeof createProjectScheduler> } = {};
    const load = vi.fn(async () => {
      for (let i = 0; i < 40; i++) holder.scheduler!.wake();
      await vi.advanceTimersByTimeAsync(0);
      throw new Error("collision");
    });
    holder.scheduler = createProjectScheduler({ project: "p", fingerprint: () => "A", load, onOutcome: () => {} });
    await holder.scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    expect(load).toHaveBeenCalledTimes(1);

    holder.scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed load is retried by a changed fingerprint or the tick, not by an equal-fingerprint wake", async () => {
    let fail = true;
    let fp = "A";
    const load = vi.fn(async () => {
      if (fail) throw new Error("bd exploded");
      return RESULT();
    });
    const { scheduler, outcomes } = make(() => fp, load);
    const o = await scheduler.loadNow();
    expect(o).toMatchObject({ ok: false, error: "bd exploded" });

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(1);

    fail = false;
    fp = "B";
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(load).toHaveBeenCalledTimes(2);
    expect(outcomes.map((x) => x.ok)).toEqual([false, true]);
  });

  it("loadNow() during an in-flight load gets a fresh load, not the stale one", async () => {
    const { load, calls } = deferredLoad();
    const { scheduler } = make(() => "A", load);
    const first = scheduler.loadNow();
    await vi.advanceTimersByTimeAsync(0);
    const second = scheduler.loadNow();
    calls[0]!.resolve(RESULT({ nodes: { created: 1, updated: 0, unchanged: 0 } }));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(RESULT({ nodes: { created: 0, updated: 0, unchanged: 9 } }));
    expect(await second).toMatchObject({ ok: true, nodes: { unchanged: 9 } });
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
    const errors = new Map<string, () => void>();
    const closed: string[] = [];
    const opened: string[] = [];
    const fps = new Map<string, string>();
    const registryReads = { fail: false };
    const watcher = createBeadsWatcher({
      db: {} as never,
      ingest: (_db, o) => opts.ingest(o.project),
      readRegistry: async () => {
        if (registryReads.fail) throw new Error("db down");
        return registry.map((r) => ({ ...r }));
      },
      watchDir: (dir, onWake, onError) => {
        wakes.set(dir, onWake);
        errors.set(dir, onError);
        opened.push(dir);
        return { close: () => closed.push(dir) };
      },
      fingerprint: (dir) => fps.get(dir) ?? `fp:${dir}`,
      log: () => {},
    });
    const events: BeadsWatcherEvent[] = [];
    watcher.events.on(BEADS_WATCHER_EVENT, (e: BeadsWatcherEvent) => events.push(e));
    return { watcher, events, wakes, errors, closed, opened, fps, registry, registryReads };
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

  it("the safety tick loads a project whose fingerprint moved without any fs event", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, fps } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS - 1);
    expect(ingest).toHaveBeenCalledTimes(1);
    fps.set("/x/a", "moved");
    await vi.advanceTimersByTimeAsync(2);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("a project whose path changed is re-pointed: old watchers closed, new path loaded, no overlap", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, registry, closed, opened } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    registry[0] = { project: "a", dir: "/x/a2" };
    const [r1, r2] = await Promise.all([watcher.reload(), watcher.reload()]); // concurrent reloads
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(closed).toContain("/x/a/.beads");
    expect(opened.filter((d) => d === "/x/a2/.beads")).toHaveLength(1);
    await watcher.stop();
  });

  it("reload() during an in-flight load gets a fresh load", async () => {
    const calls: Array<() => void> = [];
    const ingest = vi.fn(
      () =>
        new Promise<LoadResult>((resolve) => {
          calls.push(() => resolve(RESULT()));
        }),
    );
    const { watcher } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const reloading = watcher.reload();
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    calls[1]!();
    expect(await reloading).toHaveLength(1);
    await watcher.stop();
  });

  it("reload() after stop() tracks nothing and loads nothing", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, opened } = setup({ ingest });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await watcher.stop();
    ingest.mockClear();
    opened.length = 0;

    expect(await watcher.reload()).toEqual([]);
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS * 2);
    expect(ingest).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("a stopped project's late outcome emits nothing", async () => {
    let release!: () => void;
    const ingest = vi.fn(
      () =>
        new Promise<LoadResult>((resolve) => {
          release = () => resolve(RESULT({ changed: true, changedNodeIds: ["late"] }));
        }),
    );
    const { watcher, events } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = watcher.stop();
    release();
    await stopping;
    expect(events).toEqual([]);
    expect(watcher.outcomes()).toEqual([]);
  });

  it("re-attaches a watcher that errored, on the next tick", async () => {
    const { watcher, errors, opened } = setup({ ingest: async () => RESULT(), registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    expect(opened).toEqual(["/x/a/.beads"]);
    errors.get("/x/a/.beads")!();
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS + 1);
    expect(opened).toEqual(["/x/a/.beads", "/x/a/.beads"]);
    await watcher.stop();
  });

  it("a failing start-up registry read is retried from the tick", async () => {
    const ingest = vi.fn(async () => RESULT());
    const { watcher, registryReads } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    registryReads.fail = true;
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).not.toHaveBeenCalled();

    registryReads.fail = false;
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS + 1);
    expect(ingest).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("a failing project is not re-loaded by wakes (self-trigger) before the tick", async () => {
    const ingest = vi.fn(async () => {
      throw new Error("no issues");
    });
    const { watcher, wakes } = setup({ ingest, registry: [{ project: "a", dir: "/x/a" }] });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 40; i++) wakes.get("/x/a/.beads")!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ingest).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("aborts a hung load's signal after the stop grace period", async () => {
    let signal: AbortSignal | undefined;
    const watcher = createBeadsWatcher({
      db: {} as never,
      ingest: (_db, o) => {
        signal = o.signal;
        return new Promise<LoadResult>((_, reject) => o.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      readRegistry: async () => [{ project: "a", dir: "/x/a" }],
      watchDir: () => ({ close() {} }),
      fingerprint: () => "A",
      stopGraceMs: 1000,
      log: () => {},
    });
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = watcher.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await stopping;
    expect(signal?.aborted).toBe(true);
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

describe("beads watcher wake(project)", () => {
  function setup(load: () => Promise<LoadResult>) {
    const fps = new Map<string, string | null>([["/x/a", "fp1"]]);
    const ingest = vi.fn(load);
    const watcher = createBeadsWatcher({
      db: {} as never,
      ingest: () => ingest(),
      readRegistry: async () => [{ project: "a", dir: "/x/a" }],
      watchDir: () => ({ close: () => {} }),
      fingerprint: (dir) => fps.get(dir) ?? null,
      log: () => {},
    });
    return { watcher, ingest, fps };
  }

  async function started(load: () => Promise<LoadResult>) {
    const s = setup(load);
    await s.watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ingest).toHaveBeenCalledTimes(1);
    return s;
  }

  it("loads at once, without the debounce, when the fingerprint moved", async () => {
    const { watcher, ingest, fps } = await started(async () => RESULT());
    fps.set("/x/a", "fp2");
    expect(watcher.wake("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("loads on a null fingerprint", async () => {
    const { watcher, ingest, fps } = await started(async () => RESULT());
    fps.set("/x/a", null);
    expect(watcher.wake("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("skips when the fingerprint is unchanged since a successful load", async () => {
    const { watcher, ingest } = await started(async () => RESULT());
    expect(watcher.wake("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(ingest).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("retries after a failed load even when the fingerprint is unchanged", async () => {
    const { watcher, ingest } = await started(async () => {
      throw new Error("bd failed");
    });
    expect(watcher.wake("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("a wake during a load yields exactly one follow-up", async () => {
    const { load, calls } = deferredLoad();
    const { watcher, ingest, fps } = setup(load);
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(1);

    fps.set("/x/a", "fp2");
    watcher.wake("a");
    watcher.wake("a");
    watcher.wake("a");
    calls[0]!.resolve(RESULT());
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest).toHaveBeenCalledTimes(2);
    calls[1]!.resolve(RESULT());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(ingest).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("is false for a project it does not track, and after stop()", async () => {
    const { watcher, ingest, fps } = await started(async () => RESULT());
    expect(watcher.wake("nope")).toBe(false);
    await watcher.stop();
    fps.set("/x/a", "fp2");
    expect(watcher.wake("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});
