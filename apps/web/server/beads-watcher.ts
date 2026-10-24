// Beads watcher (live-beads-board, task group 3; design.md decision 5):
// keeps the store current with every registered beads checkout on this
// machine and says so on an in-process EventEmitter. Everything except
// `fs.watch` is pure and clock-injectable so the tests need neither a
// database nor real time.
//
// Events wake it, the fingerprint decides. A wake (fs event or the 30 s
// safety tick) never loads by itself: the checkout's fingerprint — sha-256
// of `noms/manifest` plus the size of `journal.idx` — is compared with the
// one the last successful load started from, and an equal one is a read and
// does nothing. That comparison is what stops the watcher triggering itself
// through its own `bd list`, which bumps mtimes under noms/ (so fs.watch
// fires) but leaves both inputs unchanged; `bd create`/`bd update` change
// both. The fingerprint is taken BEFORE the load starts, so a write landing
// mid-load leaves the stored fingerprint stale and the next wake reloads
// (harmlessly, at worst), never the reverse. A failed load keeps the old
// fingerprint, so the next wake or tick retries.
//
// A missing manifest (a beads layout change) yields a null fingerprint,
// which never equals anything: always load, noisier but never wrong. It is
// logged once per project.
//
// Per project, the scheduler is idle or loading, and a wake during a load
// sets a follow-up flag instead of starting a second load, so a burst costs
// at most two loads. Wakes debounce 300 ms. Projects have independent
// schedulers, so one project's failure or slow `bd` never delays another.
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
  /** Current fingerprint; null means unknown (always load). A throw is treated as null. */
  fingerprint: () => string | null;
  load: () => Promise<LoadResult>;
  /** Called after every load attempt, before waiters resolve. Skipped (fingerprint-equal) cycles are not reported. */
  onOutcome: (outcome: ProjectOutcome, result: LoadResult | null) => void;
  /** Called once, the first time a fingerprint comes back null. */
  onNullFingerprint?: () => void;
  clock?: Clock;
  now?: () => Date;
  debounceMs?: number;
}

export interface ProjectScheduler {
  /** A wake (fs event or tick): debounced; loads only if the fingerprint moved. During a load it just sets the follow-up flag. */
  wake(): void;
  /** Load regardless of fingerprint (start-up, refresh). Resolves with that load's outcome, or null if the scheduler was stopped first. */
  loadNow(): Promise<ProjectOutcome | null>;
  /** Cancel the debounce and refuse new work; resolves once any in-flight load has settled. */
  stop(): Promise<void>;
}

type Pending = "none" | "check" | "force";
type Waiter = (outcome: ProjectOutcome | null) => void;

export function createProjectScheduler(options: ProjectSchedulerOptions): ProjectScheduler {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => new Date());
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  let loading = false;
  let pending: Pending = "none";
  let timer: unknown = null;
  let lastFingerprint: string | null = null;
  let loadedOnce = false;
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

  async function drain(): Promise<void> {
    while (pending !== "none" && !stopped) {
      const force = pending === "force";
      pending = "none";
      const batch = waiters;
      waiters = [];

      const fp = readFingerprint();
      if (!force && fp !== null && loadedOnce && fp === lastFingerprint) {
        for (const w of batch) w(lastOutcome);
        continue;
      }

      let outcome: ProjectOutcome;
      let result: LoadResult | null = null;
      try {
        result = await options.load();
        lastFingerprint = fp;
        loadedOnce = true;
        outcome = { project: options.project, ok: true, at: now().toISOString(), changed: result.changed, nodes: result.nodes, edges: result.edges };
      } catch (err) {
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

  function request(mode: "check" | "force"): void {
    if (mode === "force" || pending === "none") pending = mode;
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
        request("check");
        return;
      }
      if (timer !== null) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        timer = null;
        if (!stopped) request("check");
      }, debounceMs);
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
  /** Replaces `ingestBeadsCheckout` (tests). */
  ingest?: (db: Database, opts: { dir: string; project: string }) => Promise<LoadResult>;
  /** Replaces the registry read (tests). */
  readRegistry?: () => Promise<BeadsRegistration[]>;
  /** Replaces `fs.watch` on one directory (tests). Must call `onWake` on any event. */
  watchDir?: (dir: string, onWake: () => void) => WatchHandle;
  fingerprint?: (dir: string) => string | null;
  clock?: Clock;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface BeadsWatcher {
  readonly events: EventEmitter;
  /** Read the registry, attach watchers, and kick off every project's first load without awaiting it. */
  start(): Promise<void>;
  /** Re-read the registry (adding, dropping, or re-pointing projects), load every project regardless of fingerprint, and report each outcome. */
  reload(): Promise<ProjectOutcome[]>;
  /** The last load outcome per project, in memory only. */
  outcomes(): ProjectOutcome[];
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

function defaultWatchDir(dir: string, onWake: () => void): WatchHandle {
  const w: FSWatcher = fsWatch(dir, { persistent: false }, () => onWake());
  // An error (directory removed) must not crash the server; the tick covers the gap.
  w.on("error", () => w.close());
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
  const ingest =
    options.ingest ?? ((db: Database, opts: { dir: string; project: string }) => ingestBeadsCheckout(db, opts));
  const readRegistry = options.readRegistry ?? (() => readRegistryFromStore(options.db));

  const events = new EventEmitter();
  const tracked = new Map<string, Tracked>();
  const lastOutcomes = new Map<string, ProjectOutcome>();
  let tick: unknown = null;
  let stopped = false;

  function emit(event: BeadsWatcherEvent): void {
    events.emit(BEADS_WATCHER_EVENT, event);
  }

  /** (Re)attach the two non-recursive watchers a project needs; idempotent, so the tick can retry a noms/ dir that did not exist yet. */
  function attachWatchers(t: Tracked): void {
    const { dir } = t.registration;
    const targets = [path.join(dir, ".beads"), findNomsDir(dir)];
    for (const target of targets) {
      if (target === null || t.watchers.has(target)) continue;
      try {
        t.watchers.set(target, watchDir(target, () => t.scheduler.wake()));
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

  function track(registration: BeadsRegistration): Tracked {
    const { project, dir } = registration;
    const scheduler = createProjectScheduler({
      project,
      fingerprint: () => fingerprint(dir),
      load: () => ingest(options.db, { dir, project }),
      onNullFingerprint: () => log(`beads watcher: no usable fingerprint for ${project} (${dir}); loading on every wake`),
      onOutcome: (outcome, result) => {
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
    const t: Tracked = { registration, scheduler, watchers: new Map() };
    attachWatchers(t);
    tracked.set(project, t);
    return t;
  }

  /** Reconcile `tracked` with the registry; returns the schedulers to load. */
  async function syncRegistry(): Promise<Tracked[]> {
    const registrations = await readRegistry();
    if (stopped) return [];
    const wanted = new Map(registrations.map((r) => [r.project, r]));
    const stopping: Promise<void>[] = [];
    for (const [project, t] of tracked) {
      const next = wanted.get(project);
      if (next === undefined || next.dir !== t.registration.dir) {
        closeWatchers(t);
        stopping.push(t.scheduler.stop());
        tracked.delete(project);
        lastOutcomes.delete(project);
      }
    }
    await Promise.all(stopping);
    for (const registration of wanted.values()) {
      if (!tracked.has(registration.project)) track(registration);
    }
    return [...tracked.values()];
  }

  function startTick(): void {
    if (tick !== null) return;
    tick = clock.setInterval(() => {
      for (const t of tracked.values()) {
        attachWatchers(t);
        t.scheduler.wake();
      }
    }, SAFETY_TICK_MS);
  }

  return {
    events,
    async start() {
      const all = await syncRegistry();
      startTick();
      for (const t of all) void t.scheduler.loadNow();
    },
    async reload() {
      const all = await syncRegistry();
      startTick();
      const results = await Promise.all(all.map((t) => t.scheduler.loadNow()));
      return results.filter((o): o is ProjectOutcome => o !== null);
    },
    outcomes() {
      return [...lastOutcomes.values()];
    },
    async stop() {
      stopped = true;
      if (tick !== null) {
        clock.clearInterval(tick);
        tick = null;
      }
      const all = [...tracked.values()];
      for (const t of all) closeWatchers(t);
      await Promise.all(all.map((t) => t.scheduler.stop()));
    },
  };
}
