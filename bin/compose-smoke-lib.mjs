// The app-compose smoke test's pure parts (tailnet-hosting task 2.5):
// compose arguments, docker output parsers, and the limit checks.
// compose-smoke.mjs is the script that runs them against docker.
//
// The dev database is compose project `bd` and holds the user's live brain;
// the smoke test ends with `down -v`. Every compose call therefore goes
// through composeArgs, which always names its own project and refuses the
// ones that hold real data.

export const SMOKE_PROJECT = "breakdown-smoke";
export const COMPOSE_FILE = "docker-compose.app.yml";
/** `bd`: the dev database (docker-compose.yml). `breakdown`: a local run of docker-compose.app.yml. */
export const PROTECTED_PROJECTS = Object.freeze(["bd", "breakdown"]);
/** The caps' sum must stay under this (container-deploy spec). */
export const TOTAL_LIMIT_BYTES = 1e9;
/** What `token.mjs create` prints: the token alone, then a newline. */
export const TOKEN_OUTPUT = /^bdt_[A-Za-z0-9_-]{43}\n$/;

export class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

/** `docker compose` arguments for one call, always scoped to the smoke project and the app file. */
export function composeArgs(args, { project = SMOKE_PROJECT, file = COMPOSE_FILE } = {}) {
  if (PROTECTED_PROJECTS.includes(project)) {
    throw new SmokeFailure(`refusing compose project "${project}": it holds real data, and the smoke test removes its volumes`);
  }
  return ["compose", "-p", project, "-f", file, ...args];
}

/** `docker inspect` JSON → the fields the limit checks read, one per container. */
export function parseInspect(json) {
  const entries = JSON.parse(json);
  if (!Array.isArray(entries)) throw new SmokeFailure("docker inspect did not return an array");
  return entries.map((entry) => ({
    name: String(entry.Name ?? "").replace(/^\//, ""),
    service: entry.Config?.Labels?.["com.docker.compose.service"] ?? null,
    memory: entry.HostConfig?.Memory ?? 0,
    memorySwap: entry.HostConfig?.MemorySwap ?? 0,
    nanoCpus: entry.HostConfig?.NanoCpus ?? 0,
    oomKilled: entry.State?.OOMKilled === true,
    restartCount: entry.RestartCount ?? 0,
  }));
}

/** cgroup v2 `memory.peak` (one integer of bytes) → bytes. */
export function parseMemoryPeak(text) {
  const trimmed = String(text).trim();
  if (!/^\d+$/.test(trimmed)) throw new SmokeFailure(`memory.peak is not a byte count: "${trimmed}"`);
  return Number(trimmed);
}

const UNIT_BYTES = {
  B: 1,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
  kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
};

function parseSize(text) {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  const unit = match ? UNIT_BYTES[match[2]] : undefined;
  if (!match || unit === undefined || !Number.isFinite(Number(match[1]))) {
    throw new SmokeFailure(`not a size: "${text}"`);
  }
  return Math.round(Number(match[1]) * unit);
}

/** `docker stats` MemUsage (`"41.2MiB / 384MiB"`) → { used, limit } in bytes. */
export function parseStatsMemUsage(text) {
  const parts = String(text).split("/");
  if (parts.length !== 2) throw new SmokeFailure(`not a MemUsage value: "${text}"`);
  return { used: parseSize(parts[0]), limit: parseSize(parts[1]) };
}

export function sumLimits(containers) {
  return containers.reduce((total, container) => total + container.memory, 0);
}

/** Every way one inspected container breaks the caps; empty when it holds them. */
export function limitProblems(container) {
  const problems = [];
  if (container.memory <= 0) problems.push("no memory limit");
  if (container.memorySwap !== container.memory) problems.push(`memswap ${container.memorySwap} is not the memory limit ${container.memory}`);
  if (container.nanoCpus <= 0) problems.push("no cpu limit");
  if (container.oomKilled) problems.push("OOM killed");
  if (container.restartCount !== 0) problems.push(`restarted ${container.restartCount} time(s)`);
  if (container.peak !== undefined && container.memory > 0 && container.peak >= container.memory) {
    problems.push(`peak ${container.peak} reached the limit ${container.memory}`);
  }
  return problems;
}

export function mib(bytes) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/** The limits-and-peaks table, as lines. */
export function formatTable(containers) {
  const rows = [
    ["service", "limit", "memswap", "cpus", "peak", "peak/limit", "oom", "restarts"],
    ...containers.map((c) => [
      c.service ?? c.name,
      mib(c.memory),
      mib(c.memorySwap),
      (c.nanoCpus / 1e9).toFixed(2),
      c.peak === undefined ? "?" : `${mib(c.peak)}${c.peakSource === "stats" ? " (stats)" : ""}`,
      c.peak === undefined || c.memory <= 0 ? "?" : `${((100 * c.peak) / c.memory).toFixed(0)}%`,
      String(c.oomKilled),
      String(c.restartCount),
    ]),
    ["total", mib(sumLimits(containers)), "", "", "", "", "", ""],
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}
