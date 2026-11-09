// mcp-service: installs the HTTP brain server (apps/mcp/src/http.ts) as a
// per-user launchd LaunchAgent and reports on it (design.md decision 7 of
// openspec/changes/shared-mcp-server). Plain Node ESM so it runs from any
// checkout without the workspace toolchain. Every external effect —
// launchctl, git, ps, fetch, the clock — is injected, so the flow is
// testable without touching launchd.
//
// The plist runs one node process with no wrapper (no pnpm, no shell), so
// launchd's SIGTERM reaches the server itself, and names node by the
// absolute path that ran install, so the service does not depend on the
// login shell's PATH or on which nvm version is active later. It carries no
// environment: DATABASE_URL comes from the workspace .env through
// resolveDatabaseUrl, exactly as for `pnpm mcp:serve`.
//
// "Healthy" means the job's own process is running and /healthz answers
// 200. A 200 alone could come from some other process on the port while the
// job crash-loops, so both install and status also require launchd to
// report `state = running` with a pid.

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const LABEL = "dev.breakdown.brain";
export const DEFAULT_PORT = 5320;
export const USAGE = [
  "usage: mcp-service install [--port <n>]   write the LaunchAgent and (re)load it",
  "       mcp-service restart [--port <n>]   same as install: reloads the current checkout",
  "       mcp-service uninstall              stop the service and remove the LaunchAgent",
  "       mcp-service status                 loaded?, /healthz, installed commit vs HEAD",
].join("\n");
const PREFIX = "mcp-service: ";
const COMMANDS = new Set(["install", "restart", "uninstall", "status"]);
const PORT = /^\d{1,5}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const PID = /^\d+$/;
const ENTRY_PARTS = ["apps", "mcp", "src", "http.ts"];
// launchctl's "no such service": 3 is ESRCH from bootout, 113 is "Could not find service".
// 112 ("Could not find domain") is deliberately not here: it is a real failure.
const NOT_LOADED_CODES = new Set([3, 113]);
const NOT_LOADED_TEXT = /no such process|could not find (specified )?service/i;
// The server's own shutdown deadline is 5s plus pool.end; ExitTimeOut gives it 15s before SIGKILL, and the wait covers that.
const BOOTOUT_WAIT_ATTEMPTS = 80;
const BOOTOUT_WAIT_MS = 250;
const EXIT_TIMEOUT_S = 15;
/** How long install waits for health: the first boot compiles the server through tsx. */
export const HEALTH_DEADLINE_MS = 15_000;
export const HEALTH_POLL_MS = 500;
// /healthz itself gives the database 2s; this leaves room for the response.
const HEALTH_FETCH_TIMEOUT_MS = 3_000;
const ERR_LOG_LINES = 20;

/** Every path the installer writes or reads, under one home directory. */
export function servicePaths(homedir) {
  const logsDir = path.join(homedir, "Library", "Logs", "breakdown");
  return {
    plist: path.join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`),
    logsDir,
    errLog: path.join(logsDir, "brain.err.log"),
    outLog: path.join(logsDir, "brain.out.log"),
    commitFile: path.join(logsDir, "brain.installed-commit"),
  };
}

export function entryPath(repoRoot) {
  return path.join(repoRoot, ...ENTRY_PARTS);
}

/**
 * @returns {{ help: true } | { error: string }
 *   | { command: "install" | "restart" | "uninstall" | "status", port: number | null }}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { port: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length === 0) return { error: "missing subcommand" };
  if (positionals.length > 1) return { error: `unexpected argument: ${positionals[1]}` };
  const [command] = positionals;
  if (!COMMANDS.has(command)) return { error: `unknown subcommand: ${command}` };
  if (values.port === undefined) return { command, port: null };
  if (command !== "install" && command !== "restart") return { error: `--port applies only to install and restart` };
  const port = parsePort(values.port);
  if (port === null) return { error: `--port must be an integer from 1 to 65535, got ${values.port}` };
  return { command, port };
}

// 0 is a valid server port (ephemeral), but a service on a port nobody knows cannot be reached or probed.
function parsePort(text) {
  const port = PORT.test(text) ? Number(text) : NaN;
  return port >= 1 && port <= 65535 ? port : null;
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** ProgramArguments: one node process, tsx as a loader, no wrapper between launchd and the server. */
export function programArguments({ execPath, repoRoot, port }) {
  return [execPath, "--import", "tsx", entryPath(repoRoot), "--port", String(port)];
}

export function renderPlist({ execPath, repoRoot, port, paths }) {
  const str = (value) => `<string>${xmlEscape(value)}</string>`;
  const args = programArguments({ execPath, repoRoot, port })
    .map((arg) => `\t\t${str(arg)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${str(LABEL)}
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WorkingDirectory</key>
\t${str(path.join(repoRoot, "apps", "mcp"))}
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>${EXIT_TIMEOUT_S}</integer>
\t<key>StandardErrorPath</key>
\t${str(paths.errLog)}
\t<key>StandardOutPath</key>
\t${str(paths.outLog)}
</dict>
</plist>
`;
}

/**
 * What a plist this script wrote runs: ProgramArguments[0] (node), the
 * entrypoint, and the port. An out-of-range port reads as absent and is
 * returned as `badPort` so the caller can say so.
 */
export function readPlist(xml) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
  const portAt = args.indexOf("--port");
  const raw = portAt >= 0 ? args[portAt + 1] : undefined;
  const port = raw === undefined ? null : parsePort(raw);
  return { node: args[0] ?? null, entry: args[3] ?? null, port, badPort: raw !== undefined && port === null ? raw : null };
}

/** The fields of `launchctl print` output a person reads. */
export function parsePrint(printOutput) {
  const pick = (key) => new RegExp(`^\\s*${key} = (.+)$`, "m").exec(printOutput)?.[1]?.trim() ?? null;
  return { state: pick("state"), pid: pick("pid"), lastExit: pick("last exit code") };
}

export function serviceDetails(printOutput) {
  const { state, pid, lastExit } = parsePrint(printOutput);
  return [["state", state], ["pid", pid], ["last exit code", lastExit]]
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key} = ${value}`)
    .join(", ");
}

function isNotLoaded(result) {
  return NOT_LOADED_CODES.has(result.code) || NOT_LOADED_TEXT.test(result.stderr) || NOT_LOADED_TEXT.test(result.stdout);
}

function oneLine(text) {
  return text.trim().replace(/\s+/g, " ");
}

/** @returns {Promise<{ ok: boolean, summary: string }>} */
export async function checkHealth(fetchFn, port) {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
    const body = oneLine(await res.text());
    return { ok: res.status === 200, summary: `${res.status} ${body}` };
  } catch (err) {
    return { ok: false, summary: `no answer on 127.0.0.1:${port} (${err?.cause?.code ?? err?.name ?? "error"})` };
  }
}

async function readIfExists(file, encoding = "utf8") {
  try {
    return await fs.readFile(file, encoding);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function statIfExists(file) {
  try {
    return await fs.stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const exists = (file) => fs.access(file).then(() => true, () => false);

async function headCommit(deps) {
  const result = await deps.run("git", ["rev-parse", "HEAD"], { cwd: deps.repoRoot });
  const head = result.stdout.trim();
  return result.code === 0 && COMMIT.test(head) ? head : null;
}

/** The job as launchd sees it. `running` requires both `state = running` and a pid. */
async function launchdJob(ctx) {
  const print = await ctx.run("launchctl", ["print", ctx.target], {});
  if (print.code !== 0) return { loaded: false, running: false, details: "", state: null, pid: null, lastExit: null };
  const fields = parsePrint(print.stdout);
  const running = fields.state === "running" && fields.pid !== null && PID.test(fields.pid);
  return { loaded: true, running, details: serviceDetails(print.stdout), ...fields };
}

/** When a pid started, from `ps -o lstart=` (local time, second resolution); null if unknown. */
async function processStart(ctx, pid) {
  const result = await ctx.run("ps", ["-o", "lstart=", "-p", pid], { env: { LC_ALL: "C" } });
  const text = oneLine(result.stdout);
  const date = result.code === 0 && text ? new Date(text) : null;
  return date && !Number.isNaN(date.getTime()) ? { date, text } : null;
}

/** The lines appended to the error log since it was `offset` bytes long (all of it, if it shrank). */
async function errLogSince(file, offset) {
  const bytes = await readIfExists(file, null);
  if (bytes === null) return [];
  const added = (bytes.length >= offset ? bytes.subarray(offset) : bytes).toString("utf8").trimEnd();
  return added ? added.split("\n").slice(-ERR_LOG_LINES) : [];
}

function notRunningReason(job) {
  if (!job.loaded) return `${LABEL} is not loaded`;
  return `${LABEL} is not running (${job.details || "no state reported"})`;
}

class Refusal extends Error {}

export async function runService(deps) {
  const parsed = parseArgs(deps.argv);
  if ("help" in parsed) {
    deps.out(USAGE);
    return { exitCode: 0 };
  }
  if ("error" in parsed) {
    deps.warn(PREFIX + parsed.error);
    deps.warn(USAGE);
    return { exitCode: 2 };
  }
  if (deps.platform !== "darwin") {
    deps.warn(
      `${PREFIX}the service installer is macOS-only (launchd); this is ${deps.platform}. The server itself is portable: ` +
        `start it directly with \`pnpm mcp:serve --port <n>\` (or \`node --import tsx apps/mcp/src/http.ts --port <n>\` from apps/mcp) under your own supervisor.`,
    );
    return { exitCode: 1 };
  }
  const ctx = { ...deps, paths: servicePaths(deps.homedir), target: `gui/${deps.uid}/${LABEL}`, domain: `gui/${deps.uid}` };
  try {
    if (parsed.command === "uninstall") return await uninstall(ctx);
    if (parsed.command === "status") return await status(ctx);
    return await install(ctx, parsed.port);
  } catch (err) {
    const message = err instanceof Refusal ? err.message : `unexpected error: ${err?.message ?? String(err)}`;
    for (const line of message.split("\n")) deps.warn(PREFIX + line);
    return { exitCode: 1 };
  }
}

/** Unloads the service if loaded; returns whether it was. Waits until launchd has let it go, so a bootstrap right after does not race the old process for the port. */
async function bootout(ctx) {
  const result = await ctx.run("launchctl", ["bootout", ctx.target], {});
  if (result.code !== 0) {
    if (isNotLoaded(result)) return false;
    throw new Refusal(`launchctl bootout ${ctx.target} failed (exit ${result.code}): ${oneLine(result.stderr || result.stdout)}`);
  }
  for (let i = 0; i < BOOTOUT_WAIT_ATTEMPTS; i++) {
    if (isNotLoaded(await ctx.run("launchctl", ["print", ctx.target], {}))) return true;
    await ctx.sleep(BOOTOUT_WAIT_MS);
  }
  throw new Refusal(`${ctx.target} was still loaded ${(BOOTOUT_WAIT_ATTEMPTS * BOOTOUT_WAIT_MS) / 1000}s after bootout; check \`launchctl print ${ctx.target}\``);
}

/** Reads the installed plist, warning about a port that cannot be used. Null when there is none. */
async function installedPlist(ctx) {
  const xml = await readIfExists(ctx.paths.plist);
  if (xml === null) return null;
  const info = readPlist(xml);
  if (info.badPort !== null) ctx.warn(`${PREFIX}${ctx.paths.plist} has --port ${info.badPort}, outside 1–65535; ignoring it`);
  return info;
}

function repoOf(entry) {
  const suffix = path.join("", ...ENTRY_PARTS);
  return entry.endsWith(path.sep + suffix) ? entry.slice(0, -(suffix.length + 1)) : entry;
}

async function install(ctx, requestedPort) {
  const { paths } = ctx;
  const previous = await installedPlist(ctx);
  // Without --port, a reinstall (or restart) keeps the port already installed.
  const port = requestedPort ?? previous?.port ?? DEFAULT_PORT;

  const wasLoaded = await bootout(ctx);
  await fs.mkdir(path.dirname(paths.plist), { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const tmp = `${paths.plist}.tmp`;
  await fs.writeFile(tmp, renderPlist({ execPath: ctx.execPath, repoRoot: ctx.repoRoot, port, paths }), { mode: 0o644 });
  await fs.rename(tmp, paths.plist);

  const commit = await headCommit(ctx);
  const errLogOffset = (await statIfExists(paths.errLog))?.size ?? 0;
  const boot = await ctx.run("launchctl", ["bootstrap", ctx.domain, paths.plist], {});
  if (boot.code !== 0) {
    throw new Refusal(`launchctl bootstrap ${ctx.domain} ${paths.plist} failed (exit ${boot.code}): ${oneLine(boot.stderr || boot.stdout)}`);
  }

  ctx.out(`${wasLoaded ? "reloaded" : "loaded"} ${LABEL}`);
  ctx.out(`  plist   ${paths.plist}`);
  ctx.out(`  node    ${ctx.execPath}`);
  if (previous?.node && previous.node !== ctx.execPath) ctx.out(`          node was ${previous.node}, now ${ctx.execPath}`);
  ctx.out(`  repo    ${ctx.repoRoot}`);
  if (previous?.entry && previous.entry !== entryPath(ctx.repoRoot)) ctx.out(`          repo was ${repoOf(previous.entry)}, now ${ctx.repoRoot}`);
  ctx.out(`  server  ${programArguments({ execPath: ctx.execPath, repoRoot: ctx.repoRoot, port }).slice(1).join(" ")}`);
  ctx.out(`  port    ${port}`);
  ctx.out(`  commit  ${commit ?? "unknown (git rev-parse HEAD failed)"}`);
  ctx.out(`  logs    ${paths.errLog}`);
  ctx.out(`          ${paths.outLog}`);

  const deadline = ctx.now() + HEALTH_DEADLINE_MS;
  let health;
  let job = null;
  for (;;) {
    health = await checkHealth(ctx.fetch, port);
    if (health.ok) {
      job = await launchdJob(ctx);
      if (job.running) break;
    }
    if (ctx.now() >= deadline) break;
    await ctx.sleep(HEALTH_POLL_MS);
  }

  // Written after the poll, so the process this install started began before
  // the file's mtime; status reads a later start time as a launchd restart.
  if (commit) await fs.writeFile(paths.commitFile, `${commit}\n`);
  else {
    await fs.rm(paths.commitFile, { force: true });
    ctx.warn(`${PREFIX}could not read HEAD in ${ctx.repoRoot}; status will not compare commits`);
  }

  if (health.ok && job?.running) {
    ctx.out(`  health  ${health.summary}`);
    ctx.out(`  pid     ${job.pid}`);
    return { exitCode: 0 };
  }
  const seconds = HEALTH_DEADLINE_MS / 1000;
  if (health.ok) {
    ctx.warn(`${PREFIX}/healthz on port ${port} answered ${health.summary}, but ${notRunningReason(job)} after ${seconds}s: some other process is answering on that port.`);
  } else {
    ctx.warn(`${PREFIX}not healthy after ${seconds}s: ${health.summary}`);
  }
  ctx.warn(`${PREFIX}launchd keeps restarting it every 10s (a database that is not up yet is retried). Added to ${paths.errLog} since bootstrap:`);
  const added = await errLogSince(paths.errLog, errLogOffset);
  for (const line of added.length ? added : ["(nothing)"]) ctx.warn(`  ${line}`);
  return { exitCode: 1 };
}

async function uninstall(ctx) {
  const { paths } = ctx;
  const wasLoaded = await bootout(ctx);
  const hadPlist = await exists(paths.plist);
  await fs.rm(paths.plist, { force: true });
  await fs.rm(paths.commitFile, { force: true });
  ctx.out(wasLoaded ? `stopped and unloaded ${LABEL}` : `${LABEL} was not loaded`);
  ctx.out(hadPlist ? `removed ${paths.plist}` : `no plist at ${paths.plist}`);
  ctx.out(`left in place: ${paths.logsDir} and the database`);
  return { exitCode: 0 };
}

async function status(ctx) {
  const { paths } = ctx;
  const job = await launchdJob(ctx);
  const plist = await installedPlist(ctx);
  const port = plist?.port ?? DEFAULT_PORT;
  const health = await checkHealth(ctx.fetch, port);

  ctx.out(`service  ${LABEL}: ${job.loaded ? "loaded" : "not loaded"}${job.details ? ` (${job.details})` : ""}`);
  ctx.out(`plist    ${plist === null ? `not installed (${paths.plist})` : paths.plist}`);
  ctx.out(`port     ${port}${plist?.port == null ? " (default)" : ""}`);
  if (plist) {
    ctx.out(`node     ${plist.node ?? "(none in plist)"}`);
    ctx.out(`entry    ${plist.entry ?? "(none in plist)"}`);
    await checkInstalledPath(ctx, "node", plist.node, ctx.execPath);
    await checkInstalledPath(ctx, "entrypoint", plist.entry, entryPath(ctx.repoRoot));
  }
  ctx.out(`health   ${health.summary}`);
  ctx.out(`commit   ${await commitLine(ctx, job)}`);
  ctx.out(`logs     ${paths.errLog}`);
  ctx.out(`         ${paths.outLog}`);
  if (health.ok && !job.running) {
    ctx.warn(`${PREFIX}/healthz answered 200, but ${notRunningReason(job)}: some other process is answering on port ${port}.`);
  }
  return { exitCode: job.running && health.ok ? 0 : 1 };
}

async function checkInstalledPath(ctx, what, installed, current) {
  if (!installed) {
    ctx.warn(`${PREFIX}the plist names no ${what}; run \`pnpm mcp:service restart\` to rewrite it`);
    return;
  }
  if (!(await exists(installed))) {
    ctx.warn(`${PREFIX}the plist's ${what} ${installed} no longer exists; run \`pnpm mcp:service restart\` from this checkout`);
  } else if (installed !== current) {
    ctx.warn(`${PREFIX}the plist's ${what} is ${installed}, but this checkout's is ${current}; run \`pnpm mcp:service restart\` to switch`);
  }
}

async function commitLine(ctx, job) {
  const raw = (await readIfExists(ctx.paths.commitFile))?.trim() ?? null;
  const installed = raw !== null && COMMIT.test(raw) ? raw : null;
  const head = await headCommit(ctx);
  const headText = head ? head.slice(0, 12) : "unknown";
  if (raw === null) return `installed unknown, HEAD ${headText}`;
  if (!installed) return `installed unknown (${ctx.paths.commitFile} is not a commit id), HEAD ${headText}`;
  const prefix = `installed ${installed.slice(0, 12)}, HEAD ${headText}`;

  // launchd restarts a crashed job, and starts it at login, from the working
  // tree, so the commit file names what runs only if the process predates it.
  const recorded = await statIfExists(ctx.paths.commitFile);
  const started = job.running ? await processStart(ctx, job.pid) : null;
  if (started && recorded && started.date.getTime() > recorded.mtimeMs) {
    return `${prefix}: launchd restarted it at ${started.text}; running code is the working tree as of then`;
  }
  if (!head) return prefix;
  if (installed === head) return `installed ${head.slice(0, 12)} = HEAD`;
  const count = await ctx.run("git", ["rev-list", "--count", "--end-of-options", `${installed}..${head}`], { cwd: ctx.repoRoot });
  const n = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  const behind = Number.isInteger(n) && n > 0 ? `restart to pick up ${n} newer commit${n === 1 ? "" : "s"}` : "differs from HEAD, restart to run HEAD";
  return `${prefix}: ${behind} (pnpm mcp:service restart)`;
}
