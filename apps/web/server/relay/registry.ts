// The relay's beads registry (laptop-relay design.md decision 3): which
// checkouts on this Mac it may run `bd` in. It is Breakdown's own list
// (`GET /relay/v1/projects`, the projects a local beads ingest registered),
// kept only where the path is a checkout here: its realpath is the path
// itself (no symlink anywhere along it, so the path names what `bd` will
// open), it is a directory, and it holds a `.beads/` directory. `--project`
// narrows it to the keys named. An action whose project or cwd is not in
// it runs nothing.
//
// Refreshed at start, before each `beads_reingest`, when a review decision
// names a project it does not hold, and every 5 minutes (main.ts). The
// response's `push` flag rides along: it says whether this Breakdown lacks
// `bd` and so needs the relay's watcher.

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { RelayClient } from "./client.js";

export const REGISTRY_REFRESH_MS = 5 * 60_000;

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
  /** `--project` keys; empty keeps every project. */
  only?: readonly string[];
  log?: (line: string) => void;
  /** Why `dir` is not a usable checkout here, or null (tests replace it). */
  checkDir?: (dir: string) => string | null;
}

/** Why `dir` cannot be one of the relay's checkouts, or null when it can. */
export function checkoutProblem(dir: string): string | null {
  if (!path.isAbsolute(dir)) return "is not an absolute path";
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    return "does not exist on this machine";
  }
  if (real !== dir) return `resolves to ${real} (a symlink or a non-canonical spelling); register the real path`;
  try {
    if (!statSync(dir).isDirectory()) return "is not a directory";
    if (!statSync(path.join(dir, ".beads")).isDirectory()) return "has no .beads/ directory";
  } catch {
    return "has no .beads/ directory";
  }
  return null;
}

function parseProjects(body: unknown): { projects: RegistryEntry[]; push: boolean } {
  const raw = body as { projects?: unknown; push?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.projects) || typeof raw.push !== "boolean") {
    throw new Error("GET /relay/v1/projects answered a body without projects and push");
  }
  const projects: RegistryEntry[] = [];
  for (const p of raw.projects as unknown[]) {
    const { key, path: dir } = (p ?? {}) as { key?: unknown; path?: unknown };
    if (typeof key === "string" && key !== "" && typeof dir === "string" && dir !== "") projects.push({ project: key, dir });
  }
  return { projects, push: raw.push };
}

export function createRelayRegistry({ client, only = [], log = () => {}, checkDir = checkoutProblem }: RelayRegistryOptions): RelayRegistry {
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
      const wanted = only.length === 0 ? parsed.projects : parsed.projects.filter((p) => only.includes(p.project));
      for (const key of only) {
        if (!parsed.projects.some((p) => p.project === key)) say(key, `[relay] project ${key} (--project) is not registered on the server; register it with a local beads ingest`);
      }
      const next: RegistryEntry[] = [];
      for (const entry of wanted) {
        const problem = checkDir(entry.dir);
        if (problem === null) {
          say(entry.project, `[relay] project ${entry.project} is the checkout at ${entry.dir}`);
          next.push(entry);
        } else {
          say(entry.project, `[relay] skipping project ${entry.project}: ${entry.dir} ${problem}`);
        }
      }
      const changed = !loaded || JSON.stringify(next) !== JSON.stringify(kept);
      kept = next;
      push = parsed.push;
      loaded = true;
      return changed;
    },
    entries: () => [...kept],
    get: (project) => kept.find((e) => e.project === project),
    push: () => push,
    loaded: () => loaded,
  };
}
