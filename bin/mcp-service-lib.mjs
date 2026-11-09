// mcp-service: installs the HTTP brain server (apps/mcp/src/http.ts) as a
// per-user launchd LaunchAgent and reports on it (design.md decision 7 of
// openspec/changes/shared-mcp-server). Plain Node ESM so it runs from any
// checkout without the workspace toolchain. Every external effect —
// launchctl, git, fetch, the clock — is injected, so the flow is testable
// without touching launchd.
//
// The plist runs one node process with no wrapper (no pnpm, no shell), so
// launchd's SIGTERM reaches the server itself, and names node by the
// absolute path that ran install, so the service does not depend on the
// login shell's PATH or on which nvm version is active later. It carries no
// environment: DATABASE_URL comes from the workspace .env through
// resolveDatabaseUrl, exactly as for `pnpm mcp:serve`.

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
// launchctl's "no such service": 3 is ESRCH from bootout, 113 is print's "Could not find service".
const NOT_LOADED_CODES = new Set([3, 113]);
const NOT_LOADED_TEXT = /no such process|could not find/i;
const BOOTOUT_WAIT_ATTEMPTS = 20;
const BOOTOUT_WAIT_MS = 250;
/** About 15s of polling after bootstrap: the first boot compiles the server through tsx. */
export const HEALTH_POLL_ATTEMPTS = 30;
export const HEALTH_POLL_MS = 500;
// /healthz itself gives the database 2s; this leaves room for the response.
const HEALTH_FETCH_TIMEOUT_MS = 3_000;
const LOG_TAIL_LINES = 5;

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
  // 0 is a valid server port (ephemeral), but a service on a port nobody knows cannot be reached or probed.
  const port = PORT.test(values.port) ? Number(values.port) : NaN;
  if (!(port >= 1 && port <= 65535)) return { error: `--port must be an integer from 1 to 65535, got ${values.port}` };
  return { command, port };
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** ProgramArguments: one node process, tsx as a loader, no wrapper between launchd and the server. */
export function programArguments({ execPath, repoRoot, port }) {
  return [execPath, "--import", "tsx", path.join(repoRoot, "apps", "mcp", "src", "http.ts"), "--port", String(port)];
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
\t<key>StandardErrorPath</key>
\t${str(paths.errLog)}
\t<key>StandardOutPath</key>
\t${str(paths.outLog)}
</dict>
</plist>
`;
}

/** The port in a plist this script wrote, or null when it has none. */
export function plistPort(xml) {
  const match = /<string>--port<\/string>\s*<string>(\d{1,5})<\/string>/.exec(xml);
  return match ? Number(match[1]) : null;
}

/** `launchctl print` output reduced to the lines a person reads: state, pid, last exit code. */
export function serviceDetails(printOutput) {
  const pick = (key) => new RegExp(`^\\s*${key} = (.+)$`, "m").exec(printOutput)?.[1]?.trim();
  return [["state", pick("state")], ["pid", pick("pid")], ["last exit code", pick("last exit code")]]
    .filter(([, value]) => value !== undefined)
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

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function headCommit(deps) {
  const result = await deps.run("git", ["rev-parse", "HEAD"], { cwd: deps.repoRoot });
  return result.code === 0 ? result.stdout.trim() : null;
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

async function install(ctx, requestedPort) {
  const { paths } = ctx;
  // Without --port, a reinstall (or restart) keeps the port already installed.
  const existing = await readIfExists(paths.plist);
  const port = requestedPort ?? (existing ? plistPort(existing) : null) ?? DEFAULT_PORT;

  const wasLoaded = await bootout(ctx);
  await fs.mkdir(path.dirname(paths.plist), { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.writeFile(paths.plist, renderPlist({ execPath: ctx.execPath, repoRoot: ctx.repoRoot, port, paths }), { mode: 0o644 });

  const commit = await headCommit(ctx);
  if (commit) await fs.writeFile(paths.commitFile, `${commit}\n`);
  else await fs.rm(paths.commitFile, { force: true });

  const boot = await ctx.run("launchctl", ["bootstrap", ctx.domain, paths.plist], {});
  if (boot.code !== 0) {
    throw new Refusal(`launchctl bootstrap ${ctx.domain} ${paths.plist} failed (exit ${boot.code}): ${oneLine(boot.stderr || boot.stdout)}`);
  }

  ctx.out(`${wasLoaded ? "reloaded" : "loaded"} ${LABEL}`);
  ctx.out(`  plist   ${paths.plist}`);
  ctx.out(`  node    ${ctx.execPath}`);
  ctx.out(`  server  ${programArguments({ execPath: ctx.execPath, repoRoot: ctx.repoRoot, port }).slice(1).join(" ")}`);
  ctx.out(`  port    ${port}`);
  ctx.out(`  commit  ${commit ?? "unknown (git rev-parse HEAD failed)"}`);
  ctx.out(`  logs    ${paths.errLog}`);
  ctx.out(`          ${paths.outLog}`);
  if (!commit) ctx.warn(`${PREFIX}could not read HEAD in ${ctx.repoRoot}; status will not compare commits`);

  let health = null;
  for (let i = 0; i < HEALTH_POLL_ATTEMPTS; i++) {
    health = await checkHealth(ctx.fetch, port);
    if (health.ok) break;
    await ctx.sleep(HEALTH_POLL_MS);
  }
  if (health.ok) {
    ctx.out(`  health  ${health.summary}`);
    return { exitCode: 0 };
  }
  ctx.warn(`${PREFIX}not healthy after ~${(HEALTH_POLL_ATTEMPTS * HEALTH_POLL_MS) / 1000}s: ${health.summary}`);
  ctx.warn(`${PREFIX}launchd keeps restarting it every 10s (a database that is not up yet is retried). Last lines of ${paths.errLog}:`);
  const errLog = await readIfExists(paths.errLog);
  const tail = errLog ? errLog.trimEnd().split("\n").slice(-LOG_TAIL_LINES) : ["(empty)"];
  for (const line of tail) ctx.warn(`  ${line}`);
  return { exitCode: 1 };
}

async function uninstall(ctx) {
  const { paths } = ctx;
  const wasLoaded = await bootout(ctx);
  const hadPlist = (await readIfExists(paths.plist)) !== null;
  await fs.rm(paths.plist, { force: true });
  await fs.rm(paths.commitFile, { force: true });
  ctx.out(wasLoaded ? `stopped and unloaded ${LABEL}` : `${LABEL} was not loaded`);
  ctx.out(hadPlist ? `removed ${paths.plist}` : `no plist at ${paths.plist}`);
  ctx.out(`left in place: ${paths.logsDir} and the database`);
  return { exitCode: 0 };
}

async function status(ctx) {
  const { paths } = ctx;
  const print = await ctx.run("launchctl", ["print", ctx.target], {});
  const loaded = print.code === 0;
  const plist = await readIfExists(paths.plist);
  const port = (plist ? plistPort(plist) : null) ?? DEFAULT_PORT;
  const health = await checkHealth(ctx.fetch, port);

  const details = loaded ? serviceDetails(print.stdout) : "";
  ctx.out(`service  ${LABEL}: ${loaded ? "loaded" : "not loaded"}${details ? ` (${details})` : ""}`);
  ctx.out(`plist    ${plist === null ? `not installed (${paths.plist})` : paths.plist}`);
  ctx.out(`port     ${port}${plist === null ? " (default)" : ""}`);
  ctx.out(`health   ${health.summary}`);
  ctx.out(`commit   ${await commitLine(ctx)}`);
  ctx.out(`logs     ${paths.errLog}`);
  ctx.out(`         ${paths.outLog}`);
  return { exitCode: loaded && health.ok ? 0 : 1 };
}

async function commitLine(ctx) {
  const installed = (await readIfExists(ctx.paths.commitFile))?.trim() || null;
  const head = await headCommit(ctx);
  if (!installed) return `installed unknown, HEAD ${head ? head.slice(0, 12) : "unknown"}`;
  if (!head) return `installed ${installed.slice(0, 12)}, HEAD unknown`;
  if (installed === head) return `installed ${head.slice(0, 12)} = HEAD`;
  const count = await ctx.run("git", ["rev-list", "--count", `${installed}..${head}`], { cwd: ctx.repoRoot });
  const n = count.code === 0 ? Number(count.stdout.trim()) : NaN;
  const behind = Number.isInteger(n) && n > 0 ? `restart to pick up ${n} newer commit${n === 1 ? "" : "s"}` : "differs from HEAD, restart to run HEAD";
  return `installed ${installed.slice(0, 12)}, HEAD ${head.slice(0, 12)}: ${behind} (pnpm mcp:service restart)`;
}
