// Beads watcher (live-beads-board, task group 3; design.md decision 5):
// keeps the store current with every registered beads checkout on this
// machine and says so on an in-process EventEmitter. Everything except
// `fs.watch` is pure and clock-injectable so the tests need neither a
// database nor real time.
//
// Events wake it, the fingerprint decides. A wake (fs event or the 30 s
// safety tick) never loads by itself: the checkout's fingerprint — sha-256
// of `noms/manifest` plus the size of `journal.idx` — is compared with the
// one the last ATTEMPT started from (failed attempts included), and an equal
// one is a read and does nothing. That comparison is what stops the watcher
// triggering itself through its own `bd list`, which fires ~40 fs events
// under noms/ (the manifest is rewritten via rename, content equal) but
// leaves both inputs unchanged; `bd create`/`bd update` change both. The
// fingerprint is taken BEFORE the load starts, so a write landing mid-load
// leaves the recorded fingerprint stale and the next wake reloads
// (harmlessly, at worst), never the reverse. Because failed attempts are
// recorded too, a project whose load keeps failing (collision, empty
// export, DB error) is retried only by the safety tick or by a real change,
// never by its own `bd` noise.
//
// A third kind of wake comes from inside the server: `wake(project)`, which
// the review decision calls after its own `bd` write so the board moves now
// rather than on the next fs event or the 30 s tick. It is the tick for one
// project, with no debounce: it loads at once (or, during a load, sets the
// one follow-up), loads on a null fingerprint, retries after a failed
// attempt, and skips only when the fingerprint is unchanged since a
// SUCCESSFUL attempt — a write that has landed has moved it, so the skip is
// only ever a write that changed nothing.
//
// A missing manifest (a beads layout change) yields a null fingerprint:
// fs wakes are ignored and only the tick (and start-up/refresh) loads —
// noisier than a fingerprint, never wrong. It is logged once per project.
//
// Per project, the scheduler is idle or loading, and a wake during a load
// sets a follow-up flag instead of starting a second load, so a burst costs
// at most two loads. The first wake arms a 300 ms debounce that later wakes
// do not re-arm (a continuous burst must not defer the load forever).
// Projects have independent schedulers, so one project's failure or slow
// `bd` never delays another; the default `bd` runner has a hard timeout and
// `stop()` aborts what is still running after a grace period.
//
// Registry syncs (start, reload, tick retry) are serialized through one
// promise chain and re-check `stopped` after every await, so nothing is
// tracked or loaded once `stop()` has begun.
//
// `fs.watch` is non-recursive on `<dir>/.beads/` (local writes touch
// `last-touched`) and on `<dir>/.beads/embeddeddolt/<db>/.dolt/noms/`
// (writes and pulls), `<db>` being the single directory under
// `embeddeddolt/`. macOS can drop events, so the 30 s tick wakes every
// project regardless: a missed wake costs latency, never correctness.
//
// Emitted on `events` under the single name `BEADS_WATCHER_EVENT` (never
// `'error'`, which Node throws on when unhandled): `changed` only when the
// load's `changed` flag is set — `edges.updated` is non-zero on every load
// and is never a signal — and `error` when a load fails. Payloads are
// JSON-plain so a subscription can forward them untouched.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, statSync, readdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { BEADS_PROJECT_NODE_TYPE, BEADS_SOURCE_SYSTEM, ingestBeadsCheckout, listNodes, type IngestBeadsCheckoutResult } from "@breakdown/core";
import type { Database } from "@breakdown/db";

export const BEADS_WATCHER_EVENT = "event";
export const DEBOUNCE_MS = 300;
export const SAFETY_TICK_MS = 30_000;

export type BeadsWatcherEvent =
  | { kind: "changed"; project: string; changedNodeIds: string[]; at: string }
  | { kind: "error"; project: string; message: string; at: string };

/** What a load reports: the slice of `ingestBeadsCheckout`'s result the watcher reads. */
export type LoadResult = Pick<IngestBeadsCheckoutResult, "changed" | "changedNodeIds" | "nodes" | "edges">;

/** The last thing that happened to a project's load; kept in memory only. */
export type ProjectOutcome =
  | { project: string; ok: true; at: string; changed: boolean; nodes: LoadResult["nodes"]; edges: LoadResult["edges"] }
  | { project: string; ok: false; at: string; error: string };

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real timers, resolved at call time so fake timers installed later still apply. The interval is unref'd: the tick must never keep a stopping process alive. */
export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

// ---------------------------------------------------------------- fingerprint

/** `<dir>/.beads/embeddeddolt/<db>/.dolt/noms`, `<db>` being the single directory under `embeddeddolt/`; null when the layout is absent or ambiguous. */
export function findNomsDir(dir: string): string | null {
  const root = path.join(dir, ".beads", "embeddeddolt");
  try {
    const dbs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dbs.length !== 1) return null;
    return path.join(root, dbs[0]!.name, ".dolt", "noms");
  } catch {
    return null;
  }
}

/** sha-256 of `noms/manifest` plus `journal.idx`'s size; null when either is missing (see the module header). */
export function fingerprintCheckout(dir: string): string | null {
  const noms = findNomsDir(dir);
  if (noms === null) return null;
  try {
    const manifest = readFileSync(path.join(noms, "manifest"));
    const journalIdxSize = statSync(path.join(noms, "journal.idx")).size;
    return createHash("sha256").update(manifest).update(`\njournal.idx:${journalIdxSize}`).digest("hex");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ scheduler

export interface ProjectSchedulerOptions {
  project: string;
  /** Current fingerprint; null means unknown. A throw is treated as null. */
  fingerprint: () => string | null;
  load: () => Promise<LoadResult>;
  /** Called after every load attempt, before waiters resolve. Skipped cycles are not reported. */
  onOutcome: (outcome: ProjectOutcome, result: LoadResult | null) => void;
  /** Called once, the first time a fingerprint comes back null. */
  onNullFingerprint?: () => void;
  clock?: Clock;
  now?: () => Date;
  debounceMs?: number;
}

export interface ProjectScheduler {
  /** An fs wake: debounced (an armed timer is never re-armed). Loads only if the fingerprint differs from the last ATTEMPT's; ignored while the fingerprint is null. */
  wake(): void;
  /** The safety tick: like a wake, but also retries a failed attempt and loads when the fingerprint is null. */
  tick(): void;
  /** Load regardless of fingerprint (start-up, refresh). Resolves with that load's outcome, or null if the scheduler was stopped first. */
  loadNow(): Promise<ProjectOutcome | null>;
  /** Cancel the debounce and refuse new work; resolves once any in-flight load has settled. */
  stop(): Promise<void>;
}

type Pending = "none" | "fs" | "tick" | "force";
const RANK: Record<Pending, number> = { none: 0, fs: 1, tick: 2, force: 3 };
type Waiter = (outcome: ProjectOutcome | null) => void;

export function createProjectScheduler(options: ProjectSchedulerOptions): ProjectScheduler {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => new Date());
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  let loading = false;
  let pending: Pending = "none";
  let timer: unknown = null;
  // The fingerprint every ATTEMPT started from, failed ones included — this
  // is what stops a self-triggered `bd list` (equal fingerprint) from
  // looping on a project whose load keeps failing or has no fingerprint.
  let attempted = false;
  let lastAttemptFingerprint: string | null = null;
  let lastAttemptOk = false;
  let lastOutcome: ProjectOutcome | null = null;
  let nullLogged = false;
  let stopped = false;
  let waiters: Waiter[] = [];
  let inflight: Promise<void> | null = null;

  function readFingerprint(): string | null {
    let fp: string | null;
    try {
      fp = options.fingerprint();
    } catch {
      fp = null;
    }
    if (fp === null && !nullLogged) {
      nullLogged = true;
      options.onNullFingerprint?.();
    }
    return fp;
  }

  function shouldSkip(mode: Pending, fp: string | null): boolean {
    if (mode === "force") return false;
    if (mode === "fs") return fp === null || (attempted && fp === lastAttemptFingerprint);
    // tick: retries failures and null fingerprints, skips an already-loaded fingerprint
    return fp !== null && attempted && fp === lastAttemptFingerprint && lastAttemptOk;
  }

  async function drain(): Promise<void> {
    while (pending !== "none" && !stopped) {
      const mode = pending;
      pending = "none";
      const batch = waiters;
      waiters = [];

      const fp = readFingerprint();
      if (shouldSkip(mode, fp)) {
        for (const w of batch) w(lastOutcome);
        continue;
      }

      attempted = true;
      lastAttemptFingerprint = fp;
      let outcome: ProjectOutcome;
      let result: LoadResult | null = null;
      try {
        result = await options.load();
        lastAttemptOk = true;
        outcome = { project: options.project, ok: true, at: now().toISOString(), changed: result.changed, nodes: result.nodes, edges: result.edges };
      } catch (err) {
        lastAttemptOk = false;
        outcome = { project: options.project, ok: false, at: now().toISOString(), error: err instanceof Error ? err.message : String(err) };
      }
      lastOutcome = outcome;
      try {
        options.onOutcome(outcome, result);
      } catch (err) {
        // A listener bug must not wedge the queue or strand waiters.
        console.error(`[breakdown-web] beads watcher listener for ${options.project} threw:`, err);
      }
      for (const w of batch) w(outcome);
    }
    loading = false;
    for (const w of waiters) w(null);
    waiters = [];
  }

  function request(mode: Exclude<Pending, "none">): void {
    if (RANK[mode] > RANK[pending]) pending = mode;
    if (!loading) {
      loading = true;
      inflight = drain().finally(() => {
        inflight = null;
      });
    }
  }

  return {
    wake() {
      if (stopped) return;
      if (loading) {
        request("fs");
        return;
      }
      // An armed timer is never re-armed: a back-to-back burst must not defer the load forever; the fingerprint gate and the follow-up absorb the rest.
      if (timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        if (!stopped) request("fs");
      }, debounceMs);
    },
    tick() {
      if (!stopped) request("tick");
    },
    loadNow() {
      if (stopped) return Promise.resolve(null);
      return new Promise<ProjectOutcome | null>((resolve) => {
        waiters.push(resolve);
        request("force");
      });
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      pending = "none";
      await inflight;
      for (const w of waiters) w(null);
      waiters = [];
    },
  };
}

// -------------------------------------------------------------------- watcher

export interface WatchHandle {
  close(): void;
}

export interface BeadsRegistration {
  project: string;
  dir: string;
}

export interface BeadsWatcherOptions {
  db: Database;
  /** Replaces `ingestBeadsCheckout` (tests). `signal` aborts the `bd` call at shutdown. */
  ingest?: (db: Database, opts: { dir: string; project: string; signal?: AbortSignal }) => Promise<LoadResult>;
  /** Replaces the registry read (tests). */
  readRegistry?: () => Promise<BeadsRegistration[]>;
  /** Replaces `fs.watch` on one directory (tests). Must call `onWake` on any event and `onError` if the watch dies. */
  watchDir?: (dir: string, onWake: () => void, onError: () => void) => WatchHandle;
  fingerprint?: (dir: string) => string | null;
  clock?: Clock;
  now?: () => Date;
  log?: (message: string) => void;
  /** How long `stop()` lets in-flight loads finish before aborting their `bd` calls. Default 5 s. */
  stopGraceMs?: number;
}

export interface BeadsWatcher {
  readonly events: EventEmitter;
  /** Read the registry, attach watchers, start the tick, and kick off every project's first load without awaiting it. A registry failure is logged and retried from the tick. */
  start(): Promise<void>;
  /** Re-read the registry (adding, dropping, or re-pointing projects), load every project regardless of fingerprint, and report each outcome. */
  reload(): Promise<ProjectOutcome[]>;
  /** The last load outcome per project, in memory only. */
  outcomes(): ProjectOutcome[];
  /** Ask one project to load now, as its safety tick would (module header). False for a project not tracked, or once `stop()` has begun. */
  wake(project: string): boolean;
  /** Close watchers and the tick, then await in-flight loads. Idempotent. */
  stop(): Promise<void>;
}

/** Reads the registry nodes `ingestBeadsCheckout` writes; rows whose metadata lacks a usable project or path are skipped. */
async function readRegistryFromStore(db: Database): Promise<BeadsRegistration[]> {
  const out: BeadsRegistration[] = [];
  let cursor = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof listNodes>> = await listNodes(db, {
      nodeTypes: [BEADS_PROJECT_NODE_TYPE],
      sourceSystems: [BEADS_SOURCE_SYSTEM],
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const node of page.nodes) {
      const { project, path: dir } = node.metadata;
      if (typeof project === "string" && project !== "" && typeof dir === "string" && dir !== "") out.push({ project, dir });
    }
    if (!page.hasMore || !page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

function defaultWatchDir(dir: string, onWake: () => void, onError: () => void): WatchHandle {
  const w: FSWatcher = fsWatch(dir, { persistent: false }, () => onWake());
  // An error (directory removed) must not crash the server; the tick re-attaches.
  w.on("error", () => {
    w.close();
    onError();
  });
  return w;
}

interface Tracked {
  registration: BeadsRegistration;
  scheduler: ProjectScheduler;
  watchers: Map<string, WatchHandle>;
}

export function createBeadsWatcher(options: BeadsWatcherOptions): BeadsWatcher {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.error(`[breakdown-web] ${m}`));
  const fingerprint = options.fingerprint ?? fingerprintCheckout;
  const watchDir = options.watchDir ?? defaultWatchDir;
  const stopGraceMs = options.stopGraceMs ?? 5_000;
  const ingest =
    options.ingest ?? ((db: Database, opts: { dir: string; project: string; signal?: AbortSignal }) => ingestBeadsCheckout(db, opts));
  const readRegistry = options.readRegistry ?? (() => readRegistryFromStore(options.db));

  const events = new EventEmitter();
  // Every open board tab holds a listener; the default cap of 10 would warn spuriously.
  events.setMaxListeners(0);
  const tracked = new Map<string, Tracked>();
  const lastOutcomes = new Map<string, ProjectOutcome>();
  const abortLoads = new AbortController();
  let tickHandle: unknown = null;
  let stopped = false;
  let registryPending = false;
  let chain: Promise<unknown> = Promise.resolve();

  function emit(event: BeadsWatcherEvent): void {
    events.emit(BEADS_WATCHER_EVENT, event);
  }

  /** (Re)attach the two non-recursive watchers a project needs and close any no longer targeted; idempotent, so the tick can retry a dir that did not exist yet or whose watch errored. */
  function attachWatchers(t: Tracked): void {
    if (stopped) return;
    const { dir } = t.registration;
    const targets = [path.join(dir, ".beads"), findNomsDir(dir)].filter((x): x is string => x !== null);
    for (const [target, handle] of t.watchers) {
      if (!targets.includes(target)) {
        try {
          handle.close();
        } catch {
          // already closed
        }
        t.watchers.delete(target);
      }
    }
    for (const target of targets) {
      if (t.watchers.has(target)) continue;
      try {
        const handle: WatchHandle = watchDir(
          target,
          () => t.scheduler.wake(),
          () => {
            if (t.watchers.get(target) === handle) t.watchers.delete(target);
          },
        );
        t.watchers.set(target, handle);
      } catch (err) {
        log(`beads watcher: cannot watch ${target} (${err instanceof Error ? err.message : String(err)}); relying on the safety tick`);
      }
    }
  }

  function closeWatchers(t: Tracked): void {
    for (const w of t.watchers.values()) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    t.watchers.clear();
  }

  function track(registration: BeadsRegistration): Tracked | null {
    if (stopped) return null;
    const { project, dir } = registration;
    let self: Tracked | undefined;
    const scheduler = createProjectScheduler({
      project,
      fingerprint: () => fingerprint(dir),
      load: () => ingest(options.db, { dir, project, signal: abortLoads.signal }),
      onNullFingerprint: () => log(`beads watcher: no usable fingerprint for ${project} (${dir}); loading on the safety tick only`),
      onOutcome: (outcome, result) => {
        // A scheduler dropped or re-pointed by a registry sync, or a stopped watcher, reports nothing.
        if (stopped || self === undefined || tracked.get(project) !== self) return;
        lastOutcomes.set(project, outcome);
        if (outcome.ok) {
          if (result?.changed) emit({ kind: "changed", project, changedNodeIds: result.changedNodeIds, at: outcome.at });
        } else {
          log(`beads watcher: load of ${project} failed: ${outcome.error}`);
          emit({ kind: "error", project, message: outcome.error, at: outcome.at });
        }
      },
      clock,
      now,
    });
    self = { registration, scheduler, watchers: new Map() };
    tracked.set(project, self);
    attachWatchers(self);
    return self;
  }

  /** Reconcile `tracked` with the registry; returns the schedulers to load. Serialized through `chain`, with `stopped` re-checked after every await. */
  function syncRegistry(): Promise<Tracked[]> {
    const run = async (): Promise<Tracked[]> => {
      if (stopped) return [];
      const registrations = await readRegistry();
      if (stopped) return [];
      const wanted = new Map(registrations.map((r) => [r.project, r]));
      const stopping: Promise<void>[] = [];
      for (const [project, t] of tracked) {
        const next = wanted.get(project);
        if (next === undefined || next.dir !== t.registration.dir) {
          closeWatchers(t);
          tracked.delete(project);
          lastOutcomes.delete(project);
          stopping.push(t.scheduler.stop());
        }
      }
      await Promise.all(stopping);
      if (stopped) return [];
      for (const registration of wanted.values()) {
        if (!tracked.has(registration.project)) track(registration);
      }
      registryPending = false;
      return [...tracked.values()];
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  function startTick(): void {
    if (stopped || tickHandle !== null) return;
    tickHandle = clock.setInterval(() => {
      if (registryPending) {
        // The start-up registry read failed: retry it, loading what it finds.
        syncRegistry()
          .then((all) => {
            for (const t of all) void t.scheduler.loadNow();
          })
          .catch((err) => log(`beads watcher: registry read still failing: ${err instanceof Error ? err.message : String(err)}`));
      }
      for (const t of tracked.values()) {
        attachWatchers(t);
        t.scheduler.tick();
      }
    }, SAFETY_TICK_MS);
  }

  return {
    events,
    async start() {
      startTick();
      try {
        const all = await syncRegistry();
        for (const t of all) void t.scheduler.loadNow();
      } catch (err) {
        registryPending = true;
        log(`beads watcher: cannot read the project registry (${err instanceof Error ? err.message : String(err)}); retrying on the safety tick`);
      }
    },
    async reload() {
      const all = await syncRegistry();
      const results = await Promise.all(all.map((t) => t.scheduler.loadNow()));
      return results.filter((o): o is ProjectOutcome => o !== null);
    },
    outcomes() {
      return [...lastOutcomes.values()];
    },
    wake(project) {
      if (stopped) return false;
      const t = tracked.get(project);
      if (t === undefined) return false;
      t.scheduler.tick();
      return true;
    },
    async stop() {
      stopped = true;
      if (tickHandle !== null) {
        clock.clearInterval(tickHandle);
        tickHandle = null;
      }
      const all = [...tracked.values()];
      tracked.clear();
      for (const t of all) closeWatchers(t);
      const settled = Promise.all(all.map((t) => t.scheduler.stop()));
      // In-flight loads get a grace period to finish; a hung `bd` is then killed.
      const grace = clock.setTimeout(() => abortLoads.abort(), stopGraceMs);
      try {
        await settled;
        await chain;
      } finally {
        clock.clearTimeout(grace);
      }
    },
  };
}
