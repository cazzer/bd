// The relay's beads registry (laptop-relay design.md decision 3): which
// checkouts on this Mac it may run `bd` in. The relay's own configuration
// is the trust anchor (`--project key=/abs/path`, bin/relay-lib.mjs):
// Breakdown may be compromised, so it never adds a checkout or re-points
// one. Its list (`GET /relay/v1/projects`) only narrows the local one:
//
// - a local project the server does not list is not watched, pushed, or
//   run (Breakdown has no board for it);
// - a server project with no local entry is ignored;
// - a server entry whose path differs from the local one is ignored with a
//   warning, and the project is not served until the two agree.
//
// A kept project must also be a checkout here (`checkoutProblem`): its
// realpath is the path itself (no symlink anywhere along it, so the path
// names what `bd` will open), it is a directory, and it holds a real
// `.beads/` directory. runners.ts checks that again immediately before
// every `bd` it spawns, so a checkout swapped for a symlink after a
// refresh runs nothing. An action whose project or cwd is not kept runs
// nothing.
//
// Refreshed at start, before each `beads_reingest`, when a review decision
// names a project it does not hold, and every 5 minutes (main.ts). The
// response's `push` flag rides along: it says whether this Breakdown lacks
// `bd` and so needs the relay's watcher.
//
// Server-supplied text (a key, a path) reaches the log only JSON-quoted, so
// it cannot forge a log line.

import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { RelayClient } from "./client.js";

export const REGISTRY_REFRESH_MS = 5 * 60_000;
const PROJECT_KEY_RE = /^[a-z0-9._-]{1,64}$/;

export interface RegistryEntry {
  project: string;
  dir: string;
}

export interface RelayRegistry {
  /** Re-reads the server's list; throws RelayRequestError when it cannot. Resolves with whether the kept entries changed. */
  refresh(signal?: AbortSignal): Promise<boolean>;
  entries(): RegistryEntry[];
  get(project: string): RegistryEntry | undefined;
  /** The server's `push` flag from the last refresh; null before the first. */
  push(): boolean | null;
  /** Whether a refresh has succeeded yet. */
  loaded(): boolean;
}

export interface RelayRegistryOptions {
  client: Pick<RelayClient, "send">;
  /** The relay's own projects (`--project key=path`): the only checkouts it may ever serve. */
  local: readonly RegistryEntry[];
  log?: (line: string) => void;
  /** Why `dir` is not a usable checkout here, or null (tests replace it). */
  checkDir?: (dir: string) => string | null;
}

/** Why `dir` cannot be one of the relay's checkouts, or null when it can (bin/relay-lib.mjs has the same check for install). */
export function checkoutProblem(dir: string): string | null {
  if (!path.isAbsolute(dir)) return "is not an absolute path";
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    return "does not exist on this machine";
  }
  if (real !== dir) return `resolves to ${real} (a symlink or a non-canonical spelling); give the real path`;
  try {
    if (!statSync(dir).isDirectory()) return "is not a directory";
    if (!lstatSync(path.join(dir, ".beads")).isDirectory()) return "has no .beads/ directory";
  } catch {
    return "has no .beads/ directory";
  }
  return null;
}

function parseProjects(body: unknown): { projects: Array<{ key: string; dir: string }>; push: boolean } {
  const raw = body as { projects?: unknown; push?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.projects) || typeof raw.push !== "boolean") {
    throw new Error("GET /relay/v1/projects answered a body without projects and push");
  }
  const projects: Array<{ key: string; dir: string }> = [];
  for (const p of raw.projects as unknown[]) {
    const { key, path: dir } = (p ?? {}) as { key?: unknown; path?: unknown };
    if (typeof key === "string" && typeof dir === "string") projects.push({ key, dir });
  }
  return { projects, push: raw.push };
}

export function createRelayRegistry({ client, local, log = () => {}, checkDir = checkoutProblem }: RelayRegistryOptions): RelayRegistry {
  let kept: RegistryEntry[] = [];
  let push: boolean | null = null;
  let loaded = false;
  /** The last thing said about each project, so a refresh repeats nothing. */
  const said = new Map<string, string>();

  function say(project: string, line: string): void {
    if (said.get(project) === line) return;
    said.set(project, line);
    log(line);
  }

  return {
    async refresh(signal) {
      const body = await client.send("GET", "/relay/v1/projects", undefined, signal === undefined ? {} : { signal });
      const parsed = parseProjects(body);
      const next: RegistryEntry[] = [];
      for (const entry of local) {
        const listed = parsed.projects.filter((p) => p.key === entry.project);
        if (listed.length === 0) {
          say(entry.project, `[relay] project ${entry.project} (${entry.dir}) is not registered on the server; not serving it until it is (register it with a local beads ingest)`);
          continue;
        }
        if (!listed.some((p) => p.dir === entry.dir)) {
          say(entry.project, `[relay] warning: the server lists project ${entry.project} at ${JSON.stringify(listed[0]!.dir)}, not this relay's ${entry.dir}; ignoring the server's entry and not serving ${entry.project} until they agree`);
          continue;
        }
        const problem = checkDir(entry.dir);
        if (problem === null) {
          say(entry.project, `[relay] project ${entry.project} is the checkout at ${entry.dir}`);
          next.push({ project: entry.project, dir: entry.dir });
        } else {
          say(entry.project, `[relay] skipping project ${entry.project}: ${entry.dir} ${problem}`);
        }
      }
      const others = parsed.projects.filter((p) => !local.some((e) => e.project === p.key));
      if (others.length > 0) {
        const named = others.slice(0, 10).map((p) => (PROJECT_KEY_RE.test(p.key) ? p.key : JSON.stringify(p.key.slice(0, 64))));
        say("server:others", `[relay] ignoring ${others.length} project(s) the server lists that this relay is not configured for (--project): ${named.join(", ")}${others.length > 10 ? ", …" : ""}`);
      }
      const changed = !loaded || JSON.stringify(next) !== JSON.stringify(kept);
      kept = next;
      push = parsed.push;
      loaded = true;
      return changed;
    },
    entries: () => kept.map((e) => ({ ...e })),
    get: (project) => {
      const entry = kept.find((e) => e.project === project);
      return entry === undefined ? undefined : { ...entry };
    },
    push: () => push,
    loaded: () => loaded,
  };
}
