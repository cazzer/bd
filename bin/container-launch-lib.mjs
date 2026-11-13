// The container launcher's logic (tailnet-hosting decision 6), pure or with
// its effects injected so tests drive it without processes or signals.
// container-launch.mjs is the thin entrypoint.
//
// The launcher is deployment glue, like the launchd plist: it alone reads
// BREAKDOWN_* and turns them into the servers' flags, and it strips them
// from the children's environment, so the servers still read only
// DATABASE_URL, BRAIN_READ_ONLY, and WEB_SERVER_PORT. An unset or empty
// variable takes its default.
import path from "node:path";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_WEB_PORT = 4310;
export const DEFAULT_MCP_PORT = 5320;
export const DEFAULT_MEDIA_DIR = "/data/media";
export const DEFAULT_APP_ROOT = "/app";

/**
 * Heap caps (MB) per child, under the 512m container cap (decision 7). They
 * cap the V8 heap only; buffers and code space sit outside them.
 */
export const HEAP_MB = Object.freeze({ migrate: 96, web: 160, mcp: 128 });

export const MIGRATE_ATTEMPTS = 30;
export const MIGRATE_RETRY_MS = 2_000;
/** One migrate attempt is SIGKILLed after this and counts as failed (a hung connect would otherwise hang the launcher). */
export const MIGRATE_TIMEOUT_MS = 15_000;
export const SHUTDOWN_DEADLINE_MS = 10_000;

export class LaunchConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaunchConfigError";
  }
}

function setting(env, name) {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function parsePort(env, name, fallback) {
  const raw = setting(env, name);
  if (raw === undefined) return fallback;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LaunchConfigError(`${name}="${env[name]}" is not a port; give an integer from 1 to 65535`);
  }
  return port;
}

/** BREAKDOWN_WEB_PORT and BREAKDOWN_MCP_PORT, defaulted and checked distinct; shared with the healthcheck. */
export function readPorts(env) {
  const web = parsePort(env, "BREAKDOWN_WEB_PORT", DEFAULT_WEB_PORT);
  const mcp = parsePort(env, "BREAKDOWN_MCP_PORT", DEFAULT_MCP_PORT);
  if (web === mcp) {
    throw new LaunchConfigError(`BREAKDOWN_WEB_PORT and BREAKDOWN_MCP_PORT are both ${web}; the two servers need different ports`);
  }
  return { web, mcp };
}

/**
 * The three children's node argv (heap flag, script, server flags) and the
 * environment they share. Throws LaunchConfigError naming the variable.
 */
export function planLaunch(env, { appRoot = DEFAULT_APP_ROOT } = {}) {
  if (setting(env, "DATABASE_URL") === undefined) {
    throw new LaunchConfigError("DATABASE_URL is not set; give the breakdown-db connection string");
  }
  const host = setting(env, "BREAKDOWN_HOST") ?? DEFAULT_HOST;
  const ports = readPorts(env);
  const allowHosts = (env["BREAKDOWN_ALLOW_HOSTS"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .flatMap((name) => ["--allow-host", name]);
  const mediaDir = setting(env, "BREAKDOWN_MEDIA_DIR") ?? DEFAULT_MEDIA_DIR;

  const script = (name) => path.join(appRoot, "dist", `${name}.mjs`);
  const heap = (name) => `--max-old-space-size=${HEAP_MB[name]}`;
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("BREAKDOWN_")));

  return {
    host,
    migrate: [heap("migrate"), script("migrate")],
    web: [
      heap("web"), script("web"),
      "--host", host, "--port", String(ports.web), ...allowHosts,
      "--client-dir", path.join(appRoot, "client"), "--media-dir", mediaDir,
    ],
    mcp: [heap("mcp"), script("mcp"), "--host", host, "--port", String(ports.mcp), ...allowHosts],
    childEnv,
  };
}

/**
 * Runs `runMigrate()` (resolves to an exit code) until it exits 0, up to
 * `attempts` times `delayMs` apart: the database app may still be starting,
 * and SkyOS apps have no depends_on. Resolves true on success. With the
 * defaults and each attempt bounded by `runWithTimeout`, the worst case
 * before giving up is 30 × 15 s + 29 × 2 s = 508 s, about 8.5 minutes; a
 * database that refuses connections fails each attempt in well under a
 * second, so the usual worst case is about a minute.
 */
export async function migrateWithRetry({ runMigrate, sleep, log, attempts = MIGRATE_ATTEMPTS, delayMs = MIGRATE_RETRY_MS }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const code = await runMigrate();
    if (code === 0) return true;
    log(`[launcher] migrate ${typeof code === "number" ? `exited ${code}` : code} (attempt ${attempt} of ${attempts})${attempt < attempts ? `; retrying in ${delayMs / 1000} s` : ""}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  return false;
}

/**
 * Resolves once `child` (a ChildProcess-like emitter of "exit" and "error")
 * is done: to its exit code, or to a phrase saying how it failed (killed by
 * a signal, failed to spawn). A child still running after `timeoutMs` is
 * sent SIGKILL and resolves to a "timed out" phrase once it exits, so
 * migrateWithRetry counts it as a failed attempt.
 */
export function runWithTimeout(child, { timeoutMs = MIGRATE_TIMEOUT_MS, kill = (c, signal) => c.kill(signal) } = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child, "SIGKILL");
    }, timeoutMs);
    const settle = (result) => {
      clearTimeout(timer);
      resolve(timedOut ? `timed out after ${timeoutMs / 1000} s and was killed` : result);
    };
    child.once("exit", (code, signal) => settle(code ?? `exited on ${signal}`));
    child.once("error", (err) => settle(`failed: ${err.message}`));
  });
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * A warning when a wildcard bind looks like it is in the host's network
 * namespace (`network_mode: host`), else null. There `0.0.0.0` binds every
 * host interface, and every process on the host is a loopback peer, which
 * admission trusts without a token.
 *
 * The heuristic: on a bridge network a container's own namespace holds only
 * loopback and `eth<n>` (one per attached network). Any other non-internal
 * interface (`docker0`, `tailscale0`, `wlan0`, `enp3s0`, `l4tbr0`, `br-…`,
 * `veth…`) belongs to a host. `interfaces` is `os.networkInterfaces()`.
 */
export function hostNetworkWarning(host, interfaces) {
  if (!WILDCARD_HOSTS.has(host)) return null;
  const hostLike = Object.entries(interfaces)
    .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal))
    .map(([name]) => name)
    .filter((name) => !/^eth\d+$/.test(name))
    .sort();
  if (hostLike.length === 0) return null;
  const shown = hostLike.length > 5 ? `${hostLike.slice(0, 5).join(", ")}, and ${hostLike.length - 5} more` : hostLike.join(", ");
  return [
    `[launcher] WARNING: binding ${host} and this container appears to share the host's network namespace (interfaces: ${shown}).`,
    "[launcher] WARNING: under host networking the servers listen on every host interface, and any process on the host is a loopback peer with tokenless access.",
    "[launcher] WARNING: run the image on a bridge network with its ports published (docker-compose.app.yml does).",
  ].join("\n");
}

/**
 * Supervises the server children (name → ChildProcess-like emitter of
 * "exit" and "error"). A child that exits on its own takes the container
 * down: the rest get SIGTERM and the launcher exits 1, so the supervisor
 * restarts it. SIGTERM/SIGINT to the launcher is forwarded to every child
 * and the launcher exits 0 once all have exited. Either way, children still
 * running after `deadlineMs` get SIGKILL and the exit code becomes 1.
 */
export function supervise(children, {
  signals,
  kill = (child, signal) => child.kill(signal),
  exit,
  log = (line) => console.error(line),
  deadlineMs = SHUTDOWN_DEADLINE_MS,
}) {
  const running = new Map(Object.entries(children));
  let exitCode = null;
  let deadline;

  const finishIfDone = () => {
    if (exitCode === null || running.size > 0) return;
    clearTimeout(deadline);
    exit(exitCode);
  };

  const stopAll = (code, signal) => {
    exitCode = code;
    for (const child of running.values()) kill(child, signal);
    deadline = setTimeout(() => {
      for (const [name, child] of running) {
        log(`[launcher] ${name} still running after ${deadlineMs} ms; sending SIGKILL`);
        kill(child, "SIGKILL");
      }
      exitCode = 1;
    }, deadlineMs);
    finishIfDone();
  };

  const exited = (name, detail) => {
    if (!running.has(name)) return;
    running.delete(name);
    if (exitCode === null) {
      log(`[launcher] ${name} ${detail}; stopping the container`);
      stopAll(1, "SIGTERM");
    } else {
      log(`[launcher] ${name} ${detail}`);
      finishIfDone();
    }
  };

  for (const [name, child] of running) {
    child.on("exit", (code, signal) => exited(name, signal ? `exited on ${signal}` : `exited ${code}`));
    child.on("error", (err) => exited(name, `failed: ${err.message}`));
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    signals.on(signal, () => {
      if (exitCode !== null) return;
      log(`[launcher] ${signal} received; stopping ${[...running.keys()].join(" and ")}`);
      stopAll(0, signal);
    });
  }
}
