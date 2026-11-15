// The laptop relay process (laptop-relay design.md decisions 7 and 9;
// docs/relay.md). bin/relay.mjs parses the flags and checks the token file,
// then calls `runRelay`, which runs until a signal:
//
// - **Check-in**, every `interval_s` the server answers (30 s), on its own
//   loop so a long action never makes the relay look offline.
// - **Claim → run → report**, one action at a time: a claim long-polls 30 s
//   and names the kinds this relay runs (`--kinds`) and its local project
//   keys (`--project`), so Breakdown hands it nothing else;
//   the action runs (execute.ts); its report is retried with backoff until
//   Breakdown takes it, because an unreported action is only reclaimed
//   after 5 minutes. A report Breakdown refuses outright (409 not_claimer:
//   it was reclaimed; 404) is given up and logged.
// - **Push watcher**, only while the server's `GET /relay/v1/projects` says
//   `push: true` (it has no `bd`): the beads watcher on this Mac's
//   checkouts with push.ts as its sink. The registry — the `--project`
//   checkouts, narrowed by the server's list — is re-read every 5 minutes,
//   and the watcher follows it — started, stopped, or reloaded.
//
// The claim loop waits for the first registry read, so a decision is never
// refused for a registry not yet loaded.
//
// Shutdown: the first SIGTERM or SIGINT aborts the long-poll and the
// sleeps, lets the action in hand finish and report (one more attempt if
// its report was waiting to retry), stops the watcher, and resolves 0. A
// second signal exits 130 at once.
//
// Failures back off exponentially up to 60 s. Every log line starts with
// `[relay]` and carries only the server's origin, this relay's client name,
// an action's id, kind, and state, an HTTP status, and the server's error
// code and message: never the token, a header, or an action's payload,
// which carries a person's message or a herdr prompt.
//
// It starts only with `bd` on PATH (exit 1 otherwise: every action and
// every push needs it); a missing `herdr` is a warning, because only
// prompts need it, and they fail one by one with the reason.

import { findOnPath as coreFindOnPath, RELAY_ACTION_KINDS, RELAY_CHECK_IN_INTERVAL_S, RELAY_MAX_AGE_S, type RelayActionKind } from "@breakdown/core";
import { createBeadsWatcher, type BeadsWatcher, type BeadsWatcherOptions } from "../beads-watcher.js";
import { createReviewWriter, type ReviewWriter } from "../review-writer.js";
import { createBackoff, createRelayClient, RelayRequestError, sleep as defaultSleep, type FetchLike } from "./client.js";
import { executeAction, reportSummary, type RelayReport } from "./execute.js";
import { createPushSink } from "./push.js";
import { createRelayRegistry, REGISTRY_REFRESH_MS, type RegistryEntry } from "./registry.js";
import { createRelayRunners, type RelayRunnerOptions } from "./runners.js";

export const RELAY_VERSION = "relay/1";
/** How long one claim long-polls (the API's maximum). */
export const CLAIM_WAIT_S = 30;
/** The claim's HTTP timeout: above `wait_s`, as docs/relay.md asks. */
const CLAIM_TIMEOUT_MS = (CLAIM_WAIT_S + 10) * 1000;
const ACTION_ID_RE = /^[1-9]\d{0,17}$/;
/** A report's `result` over this many characters is dropped (the API's cap). */
const MAX_RESULT_CHARS = 10_000;

export interface RelayOptions {
  /** The web server's origin, `http(s)://host[:port]`. */
  origin: string;
  /** This relay's client name, for the log (the token decides who it is to Breakdown). */
  name: string;
  /** `--project key=path`: the only checkouts this relay may serve. */
  projects: ReadonlyArray<{ key: string; path: string }>;
  /** `--kinds`: the action kinds it claims; every kind by default. */
  kinds?: readonly RelayActionKind[];
  /** `--herdr-socket`: the herdr servers it may prompt through. */
  herdrSockets: readonly string[];
  /** `--max-age` in milliseconds; 24 h by default. */
  maxAgeMs?: number;
  /** Reads and checks the token file (bin/relay-lib.mjs `readTokenFile`). */
  readToken: () => string | Promise<string>;
}

export interface RelayDeps {
  fetch?: FetchLike;
  findOnPath?: (binary: string) => string | null;
  /** Info lines (stdout). */
  out?: (line: string) => void;
  /** Warnings and failures (stderr). */
  warn?: (line: string) => void;
  /** Subscribes to SIGTERM/SIGINT; returns an unsubscribe. */
  onSignal?: (handler: (signal: string) => void) => () => void;
  /** The second signal's exit. */
  exit?: (code: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The spawning runners and the socket check (tests pass spies). */
  runners?: Omit<RelayRunnerOptions, "registry" | "herdrSockets" | "checkDir">;
  /** Replaces the registry's and the runners' checkout check (tests). */
  checkDir?: (dir: string) => string | null;
  /** Watcher seams (tests): clock, watchDir, fingerprint. */
  watcher?: Pick<BeadsWatcherOptions, "clock" | "watchDir" | "fingerprint" | "now" | "stopGraceMs">;
  registryRefreshMs?: number;
  random?: () => number;
}

function defaultOnSignal(handler: (signal: string) => void): () => void {
  const listeners = (["SIGTERM", "SIGINT"] as const).map((signal) => {
    const listener = () => handler(signal);
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  return () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : String(err);
}

interface Claimed {
  id: string;
  kind: unknown;
  payload: unknown;
  attempts: unknown;
  createdAt: unknown;
}

function claimedAction(body: unknown): Claimed | null {
  const action = (body as { action?: unknown } | null)?.action;
  if (action === null || action === undefined || typeof action !== "object") return null;
  const { id, kind, payload, attempts, created_at: createdAt } = action as Record<string, unknown>;
  return { id: typeof id === "number" || typeof id === "string" ? String(id) : "", kind, payload, attempts, createdAt };
}

function reportBody(report: RelayReport): Record<string, unknown> {
  const result = report.result !== undefined && JSON.stringify(report.result).length <= MAX_RESULT_CHARS ? report.result : undefined;
  return report.state === "done" ? { state: "done", ...(result === undefined ? {} : { result }) } : { state: "failed", error: report.error, ...(result === undefined ? {} : { result }) };
}

/** Runs the relay until a signal; resolves with the process's exit code. */
export async function runRelay(options: RelayOptions, deps: RelayDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const sleep = deps.sleep ?? defaultSleep;
  const findOnPath = deps.findOnPath ?? ((binary: string) => coreFindOnPath(binary));
  const { origin, name } = options;
  const kinds = options.kinds ?? [...RELAY_ACTION_KINDS];
  const maxAgeMs = options.maxAgeMs ?? RELAY_MAX_AGE_S * 1000;
  const localKeys = options.projects.map((p) => p.key);
  if (localKeys.length === 0) {
    warn("[relay] cannot start: no --project key=path given; the relay runs bd only in checkouts named on its own command line");
    return 1;
  }

  const bd = findOnPath("bd");
  if (bd === null) {
    warn(`[relay] cannot start: bd is not on PATH (${process.env["PATH"] ?? ""}); every action and every push needs it. Reinstall the service (pnpm relay:service install) from a shell where \`which bd\` answers.`);
    return 1;
  }
  const herdr = findOnPath("herdr");
  if (herdr === null) warn("[relay] warning: herdr is not on PATH; herdr prompts (review and inbox replies) will fail until it is");

  const stopping = new AbortController();
  const signal = stopping.signal;
  const offSignal = (deps.onSignal ?? defaultOnSignal)((name) => {
    if (signal.aborted) {
      warn(`[relay] ${name} again: exiting now`);
      (deps.exit ?? ((code: number) => process.exit(code)))(130);
      return;
    }
    out(`[relay] ${name}: finishing the action in hand, then exiting`);
    stopping.abort();
  });

  const client = createRelayClient({ origin, readToken: options.readToken, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const checkDir = deps.checkDir === undefined ? {} : { checkDir: deps.checkDir };
  const registry = createRelayRegistry({ client, local: options.projects.map((p) => ({ project: p.key, dir: p.path })), log: out, ...checkDir });
  const runners = createRelayRunners({ registry, herdrSockets: options.herdrSockets, ...deps.runners, ...checkDir });
  const sink = createPushSink({ client, runBdFor: (project) => runners.ingestBdFor(project) });
  const writers = new Map<string, ReviewWriter>();
  let watcher: BeadsWatcher | null = null;

  out(`[relay] ${RELAY_VERSION} starting as ${name} for ${origin}; bd ${bd}${herdr === null ? "" : `, herdr ${herdr}`}; projects ${options.projects.map((p) => `${p.key}=${p.path}`).join(", ")}; kinds ${kinds.join(", ")}; herdr sockets ${options.herdrSockets.join(", ") || "none"}; max age ${Math.round(maxAgeMs / 60_000)} min`);

  function syncWatcher(changed: boolean): void {
    const push = registry.push();
    if (push === true && watcher === null) {
      out(`[relay] ${origin} has no bd: watching ${registry.entries().length} checkout(s) and pushing their beads`);
      watcher = createBeadsWatcher({
        ingest: (request) => sink.push(request),
        readRegistry: async () => registry.entries().map((e: RegistryEntry) => ({ project: e.project, dir: e.dir })),
        log: (line) => warn(`[relay] ${line}`),
        ...deps.watcher,
      });
      void watcher.start();
    } else if (push === false && watcher !== null) {
      out(`[relay] ${origin} has bd again and watches its own checkouts: stopping the push watcher`);
      const old = watcher;
      watcher = null;
      void old.stop();
    } else if (watcher !== null && changed) {
      void watcher.reload().catch((err) => warn(`[relay] beads watcher reload failed: ${errorText(err)}`));
    }
  }

  async function refreshRegistry(): Promise<boolean> {
    const changed = await registry.refresh(signal);
    syncWatcher(changed);
    return changed;
  }

  async function reingest(project: string): Promise<{ changed: boolean }> {
    if (watcher !== null) {
      const outcome = await watcher.reloadProject(project);
      if (outcome === null) throw new Error(`project ${project} is not being watched`);
      if (!outcome.ok) throw new Error(outcome.error);
      return { changed: outcome.changed };
    }
    const entry = registry.get(project);
    if (entry === undefined) throw new Error(`project ${project} is not in this relay's registry`);
    const pushed = await sink.push({ dir: entry.dir, project });
    return { changed: pushed.changed };
  }

  const execDeps = {
    registry: { get: (project: string) => registry.get(project), refresh: () => refreshRegistry() },
    writerFor(project: string): ReviewWriter {
      let writer = writers.get(project);
      if (writer === undefined) {
        writer = createReviewWriter({ runBd: runners.bdFor(project), runHerdr: runners.runHerdr });
        writers.set(project, writer);
      }
      return writer;
    },
    runHerdr: runners.runHerdr,
    reingest,
    kinds,
    maxAgeMs,
  };

  async function firstRegistryRead(): Promise<boolean> {
    const backoff = createBackoff(deps.random === undefined ? {} : { random: deps.random });
    let last = "";
    while (!signal.aborted) {
      try {
        await refreshRegistry();
        return true;
      } catch (err) {
        if (signal.aborted) break;
        const text = errorText(err);
        if (text !== last) warn(`[relay] cannot read the project registry: ${text}; retrying`);
        last = text;
        await sleep(backoff.next(), signal);
      }
    }
    return false;
  }

  async function checkInLoop(): Promise<void> {
    let intervalS = RELAY_CHECK_IN_INTERVAL_S;
    let checkedIn = false;
    let lastFailure = "";
    while (!signal.aborted) {
      try {
        const answer = (await client.send("POST", "/relay/v1/check-in", { version: RELAY_VERSION }, { signal })) as { interval_s?: unknown } | null;
        const given = answer?.interval_s;
        if (typeof given === "number" && Number.isInteger(given) && given >= 1 && given <= 3600) intervalS = given;
        if (!checkedIn) out(`[relay] checked in to ${origin} as ${name} (every ${intervalS} s)`);
        checkedIn = true;
        lastFailure = "";
      } catch (err) {
        if (signal.aborted) break;
        const text = errorText(err);
        if (text !== lastFailure) warn(`[relay] check-in failed: ${text}`);
        lastFailure = text;
        checkedIn = false;
      }
      await sleep(intervalS * 1000, signal);
    }
  }

  async function report(id: string, kind: string, outcome: RelayReport): Promise<void> {
    const backoff = createBackoff(deps.random === undefined ? {} : { random: deps.random });
    let lastTry = signal.aborted;
    for (;;) {
      try {
        const answer = (await client.send("POST", `/relay/v1/actions/${id}/result`, reportBody(outcome))) as { already_finished?: unknown } | null;
        out(`[relay] action ${id} ${kind} reported ${outcome.state}${answer?.already_finished === true ? " (it was already finished)" : ""}`);
        return;
      } catch (err) {
        const text = errorText(err);
        if (err instanceof RelayRequestError && !err.retryable) {
          warn(`[relay] action ${id} ${kind}: the report was refused (${text}); giving it up`);
          return;
        }
        if (lastTry) {
          warn(`[relay] action ${id} ${kind}: the report failed at shutdown (${text}); Breakdown requeues it after 5 minutes`);
          return;
        }
        warn(`[relay] action ${id} ${kind}: the report failed (${text}); retrying`);
        await sleep(backoff.next(), signal);
        if (signal.aborted) lastTry = true;
      }
    }
  }

  async function claimLoop(): Promise<void> {
    if (!(await firstRegistryRead())) return;
    const backoff = createBackoff(deps.random === undefined ? {} : { random: deps.random });
    let lastFailure = "";
    while (!signal.aborted) {
      const started = Date.now();
      let body: unknown;
      try {
        body = await client.send("POST", "/relay/v1/claim", { wait_s: CLAIM_WAIT_S, kinds, projects: localKeys }, { signal, timeoutMs: CLAIM_TIMEOUT_MS });
        backoff.reset();
        lastFailure = "";
      } catch (err) {
        if (signal.aborted) break;
        const text = errorText(err);
        if (text !== lastFailure) warn(`[relay] claim failed: ${text}`);
        lastFailure = text;
        await sleep(backoff.next(), signal);
        continue;
      }
      const action = claimedAction(body);
      if (action === null) {
        // An empty answer well before wait_s is a server shutting down (docs/relay.md): do not spin.
        if (Date.now() - started < 1000) await sleep(1000, signal);
        continue;
      }
      const kind = typeof action.kind === "string" && /^[a-z_]{1,40}$/.test(action.kind) ? action.kind : "(unknown kind)";
      if (!ACTION_ID_RE.test(action.id)) {
        warn(`[relay] the server handed out an action with an unusable id; it cannot be reported and is left for the reclaim`);
        continue;
      }
      out(`[relay] action ${action.id} ${kind} claimed${typeof action.attempts === "number" && action.attempts > 1 ? ` (attempt ${action.attempts})` : ""}`);
      const outcome = await executeAction(action, execDeps);
      out(`[relay] action ${action.id} ${kind} ${reportSummary(outcome)}`);
      await report(action.id, kind, outcome);
    }
  }

  async function registryLoop(): Promise<void> {
    const every = deps.registryRefreshMs ?? REGISTRY_REFRESH_MS;
    while (!signal.aborted) {
      await sleep(every, signal);
      if (signal.aborted) break;
      try {
        await refreshRegistry();
      } catch (err) {
        if (!signal.aborted) warn(`[relay] cannot re-read the project registry: ${errorText(err)}`);
      }
    }
  }

  try {
    await Promise.all([checkInLoop(), claimLoop(), registryLoop()]);
    const last = watcher as BeadsWatcher | null;
    watcher = null;
    if (last !== null) await last.stop();
    out("[relay] stopped");
    return 0;
  } finally {
    offSignal();
  }
}
