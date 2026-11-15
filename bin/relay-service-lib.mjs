// relay-service: installs the laptop relay (bin/relay.mjs) as a per-user
// launchd LaunchAgent and reports on it (laptop-relay design.md decisions 7
// and 9), modelled on mcp-service-lib.mjs, whose plist escaping and
// `launchctl print` parsing it reuses. Every external effect — launchctl,
// the filesystem under the given home, PATH lookups, the clock — is
// injected, so the flow is testable without touching launchd.
//
// The plist runs one node process with no wrapper (no pnpm, no shell), so
// launchd's SIGTERM reaches the relay itself, which finishes the action in
// hand and reports it; ExitTimeOut gives it 60 s before SIGKILL. node is
// named by the absolute path that ran install. launchd's PATH is the
// system's, without Homebrew or ~/.local/bin, so the plist sets PATH to the
// directories holding `bd` and `herdr` as they resolve when install runs,
// then the system directories; install refuses without `bd` (the relay
// cannot start without it) and warns without `herdr`.
//
// The token is never in the plist and never printed: the plist names the
// token file, which install checks (relay-lib.mjs `readTokenFile`: a
// regular file of yours, mode 0600, one token) so a bad one is refused here
// rather than crash-looping under launchd.
//
// "Healthy" means launchd reports the job running with a pid and the
// relay's log shows `[relay] checked in` after its latest `[relay] … starting`.

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { parsePrint, serviceDetails, xmlEscape } from "./mcp-service-lib.mjs";
import { parseOrigin } from "./relay-lib.mjs";

export const LABEL = "dev.breakdown.relay";
export const USAGE = [
  "usage: relay-service install --url <http(s)://host[:port]> --name <client> [--token-file <path>] [--project <key>]...",
  "                              write the LaunchAgent and (re)load it; --token-file defaults to ~/.config/breakdown/relay-token",
  "       relay-service uninstall   stop the service and remove the LaunchAgent",
  "       relay-service status      loaded?, its bd/herdr, and whether it has checked in",
].join("\n");
const PREFIX = "relay-service: ";
const COMMANDS = new Set(["install", "uninstall", "status"]);
const ENTRY_PARTS = ["bin", "relay.mjs"];
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const PID = /^\d+$/;
const NOT_LOADED_CODES = new Set([3, 113]);
const NOT_LOADED_TEXT = /no such process|could not find (specified )?service/i;
/** The relay finishes the action in hand before it exits; a review decision takes seconds, rarely more. */
export const EXIT_TIMEOUT_S = 60;
const BOOTOUT_WAIT_ATTEMPTS = 280;
const BOOTOUT_WAIT_MS = 250;
/** How long install waits for the first check-in: tsx compiles the relay on first start. */
export const CHECK_IN_DEADLINE_MS = 20_000;
export const CHECK_IN_POLL_MS = 500;
const LOG_LINES = 20;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
const PROJECT_KEY_RE = /^[a-z0-9._-]{1,64}$/;

export function servicePaths(homedir) {
  const logsDir = path.join(homedir, "Library", "Logs", "breakdown");
  return {
    plist: path.join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`),
    logsDir,
    errLog: path.join(logsDir, "relay.err.log"),
    outLog: path.join(logsDir, "relay.out.log"),
    defaultTokenFile: path.join(homedir, ".config", "breakdown", "relay-token"),
  };
}

export function entryPath(repoRoot) {
  return path.join(repoRoot, ...ENTRY_PARTS);
}

/**
 * @returns {{ help: true } | { error: string } | { command: "uninstall" | "status" }
 *   | { command: "install", origin: string, name: string, tokenFile: string | null, projects: string[] }}
 */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: "string" },
        name: { type: "string" },
        "token-file": { type: "string" },
        project: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
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
  const flags = ["url", "name", "token-file", "project"].filter((f) => values[f] !== undefined);
  if (command !== "install") return flags.length > 0 ? { error: `--${flags[0]} applies only to install` } : { command };

  if (values.url === undefined) return { error: "--url is required" };
  if (values.name === undefined) return { error: "--name is required" };
  const origin = parseOrigin(values.url);
  if ("error" in origin) return origin;
  if (!NAME_RE.test(values.name)) return { error: `--name must be a client name (a letter or digit, then letters, digits, . _ @ : -), got ${JSON.stringify(values.name)}` };
  const tokenFile = values["token-file"] ?? null;
  if (tokenFile !== null && !path.isAbsolute(tokenFile)) return { error: `--token-file must be an absolute path, got ${tokenFile}` };
  const projects = [];
  for (const key of values.project ?? []) {
    if (!PROJECT_KEY_RE.test(key)) return { error: `--project must be a project key matching [a-z0-9._-]{1,64}, got ${JSON.stringify(key)}` };
    if (!projects.includes(key)) projects.push(key);
  }
  return { command, origin: origin.origin, name: values.name, tokenFile: tokenFile === null ? null : path.normalize(tokenFile), projects };
}

/** launchd's PATH: the directories of `bd` and `herdr` as resolved at install, then the system's; each once. */
export function servicePathEnv({ bd, herdr }) {
  const dirs = [];
  for (const dir of [bd && path.dirname(bd), herdr && path.dirname(herdr), ...SYSTEM_PATH]) {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(":");
}

/** ProgramArguments: one node process, tsx as a loader, no wrapper between launchd and the relay. */
export function programArguments({ execPath, repoRoot, origin, tokenFile, name, projects }) {
  return [execPath, "--import", "tsx", entryPath(repoRoot), "--url", origin, "--token-file", tokenFile, "--name", name, ...projects.flatMap((p) => ["--project", p])];
}

export function renderPlist({ execPath, repoRoot, origin, tokenFile, name, projects, pathEnv, paths }) {
  const str = (value) => `<string>${xmlEscape(value)}</string>`;
  const args = programArguments({ execPath, repoRoot, origin, tokenFile, name, projects })
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
\t${str(path.join(repoRoot, "apps", "web"))}
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t${str(pathEnv)}
\t</dict>
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

function xmlUnescape(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/** What a plist this script wrote runs: node, the entrypoint, the flags, and PATH. */
export function readPlist(xml) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? (args[at + 1] ?? null) : null;
  };
  const projects = args.flatMap((arg, i) => (arg === "--project" && args[i + 1] !== undefined ? [args[i + 1]] : []));
  const pathRaw = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml)?.[1];
  return {
    node: args[0] ?? null,
    entry: args[3] ?? null,
    origin: flag("--url"),
    tokenFile: flag("--token-file"),
    name: flag("--name"),
    projects,
    pathEnv: pathRaw === undefined ? null : xmlUnescape(pathRaw),
  };
}

function isNotLoaded(result) {
  return NOT_LOADED_CODES.has(result.code) || NOT_LOADED_TEXT.test(result.stderr) || NOT_LOADED_TEXT.test(result.stdout);
}

function oneLine(text) {
  return text.trim().replace(/\s+/g, " ");
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function sizeOf(file) {
  try {
    return (await fs.stat(file)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Whether the relay's latest start (its `[relay] … starting` line) was
 * followed by a check-in, from the out log; the last lines of both logs
 * after that start are kept for the person to read.
 */
export function checkInState(outText) {
  const lines = (outText ?? "").split("\n");
  let started = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\[relay\] \S+ starting as /.test(lines[i])) {
      started = i;
      break;
    }
  }
  if (started < 0) return { started: false, checkedIn: false, line: null };
  const checked = lines.slice(started + 1).find((l) => l.startsWith("[relay] checked in"));
  return { started: true, checkedIn: checked !== undefined, line: checked ?? null };
}

async function launchdJob(ctx) {
  const print = await ctx.run("launchctl", ["print", ctx.target], {});
  if (print.code !== 0) return { loaded: false, running: false, details: "", pid: null };
  const fields = parsePrint(print.stdout);
  const running = fields.state === "running" && fields.pid !== null && PID.test(fields.pid);
  return { loaded: true, running, details: serviceDetails(print.stdout), ...fields };
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
    deps.warn(`${PREFIX}the service installer is macOS-only (launchd); this is ${deps.platform}. Run the relay under your own supervisor: cd apps/web && node --import tsx ../../bin/relay.mjs --url … --token-file … --name …`);
    return { exitCode: 1 };
  }
  const ctx = { ...deps, paths: servicePaths(deps.homedir), target: `gui/${deps.uid}/${LABEL}`, domain: `gui/${deps.uid}` };
  try {
    if (parsed.command === "uninstall") return await uninstall(ctx);
    if (parsed.command === "status") return await status(ctx);
    return await install(ctx, parsed);
  } catch (err) {
    const message = err instanceof Refusal ? err.message : `unexpected error: ${err?.message ?? String(err)}`;
    for (const line of message.split("\n")) deps.warn(PREFIX + line);
    return { exitCode: 1 };
  }
}

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

async function install(ctx, args) {
  const { paths } = ctx;
  const tokenFile = args.tokenFile ?? paths.defaultTokenFile;
  try {
    ctx.readTokenFile(tokenFile);
  } catch (err) {
    throw new Refusal(`${err.message}. Nothing was installed.`);
  }
  const bd = ctx.findOnPath("bd");
  if (bd === null) throw new Refusal("bd is not on PATH; the relay runs every action and push with it. Install it, or run this from a shell where `which bd` answers. Nothing was installed.");
  const herdr = ctx.findOnPath("herdr");
  if (herdr === null) ctx.warn(`${PREFIX}warning: herdr is not on PATH; the relay will start, but review and inbox replies to agents will fail until it is and the service is reinstalled`);
  const pathEnv = servicePathEnv({ bd, herdr });

  const wasLoaded = await bootout(ctx);
  await fs.mkdir(path.dirname(paths.plist), { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const tmp = `${paths.plist}.tmp`;
  const plist = renderPlist({ execPath: ctx.execPath, repoRoot: ctx.repoRoot, origin: args.origin, tokenFile, name: args.name, projects: args.projects, pathEnv, paths });
  await fs.writeFile(tmp, plist, { mode: 0o644 });
  await fs.rename(tmp, paths.plist);

  const outOffset = await sizeOf(paths.outLog);
  const errOffset = await sizeOf(paths.errLog);
  const boot = await ctx.run("launchctl", ["bootstrap", ctx.domain, paths.plist], {});
  if (boot.code !== 0) throw new Refusal(`launchctl bootstrap ${ctx.domain} ${paths.plist} failed (exit ${boot.code}): ${oneLine(boot.stderr || boot.stdout)}`);

  ctx.out(`${wasLoaded ? "reloaded" : "loaded"} ${LABEL}`);
  ctx.out(`  plist       ${paths.plist}`);
  ctx.out(`  node        ${ctx.execPath}`);
  ctx.out(`  relay       ${entryPath(ctx.repoRoot)}`);
  ctx.out(`  url         ${args.origin}`);
  ctx.out(`  name        ${args.name}`);
  ctx.out(`  token file  ${tokenFile}`);
  ctx.out(`  projects    ${args.projects.length > 0 ? args.projects.join(", ") : "all registered"}`);
  ctx.out(`  bd          ${bd}`);
  ctx.out(`  herdr       ${herdr ?? "not found"}`);
  ctx.out(`  PATH        ${pathEnv}`);
  ctx.out(`  logs        ${paths.outLog}`);
  ctx.out(`              ${paths.errLog}`);

  const deadline = ctx.now() + CHECK_IN_DEADLINE_MS;
  let state = { checkedIn: false, line: null };
  let job = null;
  for (;;) {
    const outText = await readIfExists(paths.outLog);
    state = checkInState(outText === null ? "" : outText.slice(outOffset));
    job = await launchdJob(ctx);
    if (state.checkedIn && job.running) break;
    if (ctx.now() >= deadline) break;
    await ctx.sleep(CHECK_IN_POLL_MS);
  }
  if (state.checkedIn && job.running) {
    ctx.out(`  check-in    ${state.line}`);
    ctx.out(`  pid         ${job.pid}`);
    return { exitCode: 0 };
  }
  const seconds = CHECK_IN_DEADLINE_MS / 1000;
  ctx.warn(`${PREFIX}no check-in after ${seconds}s (${job.loaded ? job.details || "no state reported" : `${LABEL} is not loaded`}). launchd restarts it every 10s; an unreachable server is retried. Added to ${paths.errLog} since bootstrap:`);
  const added = ((await readIfExists(paths.errLog)) ?? "").slice(errOffset).trimEnd();
  for (const line of added ? added.split("\n").slice(-LOG_LINES) : ["(nothing)"]) ctx.warn(`  ${line}`);
  return { exitCode: 1 };
}

async function uninstall(ctx) {
  const { paths } = ctx;
  const wasLoaded = await bootout(ctx);
  const hadPlist = (await readIfExists(paths.plist)) !== null;
  await fs.rm(paths.plist, { force: true });
  ctx.out(wasLoaded ? `stopped and unloaded ${LABEL}` : `${LABEL} was not loaded`);
  ctx.out(hadPlist ? `removed ${paths.plist}` : `no plist at ${paths.plist}`);
  ctx.out(`left in place: ${paths.logsDir} and the token file`);
  return { exitCode: 0 };
}

async function status(ctx) {
  const { paths } = ctx;
  const job = await launchdJob(ctx);
  const xml = await readIfExists(paths.plist);
  const plist = xml === null ? null : readPlist(xml);
  ctx.out(`service     ${LABEL}: ${job.loaded ? "loaded" : "not loaded"}${job.details ? ` (${job.details})` : ""}`);
  ctx.out(`plist       ${plist === null ? `not installed (${paths.plist})` : paths.plist}`);
  let healthy = job.running;
  if (plist !== null) {
    ctx.out(`url         ${plist.origin ?? "(none in plist)"}`);
    ctx.out(`name        ${plist.name ?? "(none in plist)"}`);
    ctx.out(`token file  ${plist.tokenFile ?? "(none in plist)"}`);
    ctx.out(`projects    ${plist.projects.length > 0 ? plist.projects.join(", ") : "all registered"}`);
    ctx.out(`node        ${plist.node ?? "(none in plist)"}`);
    ctx.out(`PATH        ${plist.pathEnv ?? "(none in plist)"}`);
    const bd = plist.pathEnv === null ? null : ctx.findOnPath("bd", plist.pathEnv);
    const herdr = plist.pathEnv === null ? null : ctx.findOnPath("herdr", plist.pathEnv);
    ctx.out(`bd          ${bd ?? "not found on the service's PATH: reinstall from a shell where `which bd` answers"}`);
    ctx.out(`herdr       ${herdr ?? "not found on the service's PATH: replies to agents fail"}`);
    if (bd === null) healthy = false;
    if (plist.tokenFile !== null) {
      try {
        ctx.readTokenFile(plist.tokenFile);
      } catch (err) {
        ctx.warn(`${PREFIX}${err.message}`);
        healthy = false;
      }
    }
  }
  const state = checkInState(await readIfExists(paths.outLog));
  ctx.out(`check-in    ${state.checkedIn ? state.line : state.started ? "none since the relay last started" : `no relay start in ${paths.outLog}`}`);
  ctx.out(`logs        ${paths.outLog}`);
  ctx.out(`            ${paths.errLog}`);
  return { exitCode: healthy && state.checkedIn ? 0 : 1 };
}
