// relay: the pure parts of the laptop relay's command line (laptop-relay
// design.md decisions 7 and 9): its flags and its token file. Plain Node
// ESM with no workspace imports, so bin/relay.mjs can refuse a bad start
// before loading the relay itself, and bin/relay-service-lib.mjs checks
// the same things at install.
//
// The relay's configuration is its trust anchor: Breakdown may be
// compromised, so it never decides where `bd` runs or which herdr server is
// prompted. The checkouts come only from `--project key=/abs/path`
// (Breakdown's project list can narrow them, never add one or re-point
// one), the herdr servers only from `--herdr-socket` (herdr's default
// socket for this user when none is given), the kinds of action claimed
// from `--kinds`, and the oldest action it will run from `--max-age`.
//
// `--url` must be https, or http to a host whose traffic does not cross an
// untrusted network: loopback, a tailnet address (100.64.0.0/10), or a
// MagicDNS name (`*.ts.net`). Tailscale encrypts the tailnet hop itself.
//
// The token file is the relay's own secret, never an environment variable
// a server reads. It is opened with O_NOFOLLOW (a symlink is refused, never
// followed) and checked on the open descriptor — a regular file, owned by
// the user running the relay, readable by that user alone (no group or
// other bits) — and read from that same descriptor, so nothing can swap
// the file between the check and the read. It must hold one token: a
// single line of 1 to 512 characters with no whitespace inside. A refusal
// names the path and what is wrong — the mode in octal, with the chmod
// that fixes it — and never the file's contents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const RELAY_KINDS = ["review_decision", "herdr_prompt", "beads_reingest", "review_request"];
export const DEFAULT_MAX_AGE = "24h";

export const RELAY_USAGE = [
  "usage: relay --url <http(s)://host[:port]> --token-file <absolute path> --name <client> --project <key>=<absolute path>...",
  "             [--kinds <kind>[,<kind>]...] [--herdr-socket <absolute path>]... [--max-age <n>s|m|h|d]",
  "  --url           the Breakdown web server (its origin: no path, query, or credentials); http only to",
  "                  loopback, a tailnet address (100.64.0.0/10), or a *.ts.net name",
  "  --token-file    a file holding the relay-scoped token, mode 0600 (pnpm -s client-token create <name> --scope relay)",
  "  --name          this relay's client name, as minted (for the log)",
  "  --project       a beads checkout this relay serves: its project key and its real path (repeatable, at least one)",
  `  --kinds         the action kinds it claims, comma-separated (default: ${RELAY_KINDS.join(",")})`,
  "  --herdr-socket  a herdr server socket it may prompt through (repeatable; default ~/.config/herdr/herdr.sock)",
  `  --max-age       refuse an action queued longer ago than this (default ${DEFAULT_MAX_AGE})`,
].join("\n");

export const MAX_TOKEN_LENGTH = 512;
/** A token file larger than this is refused before it is read. */
export const MAX_TOKEN_FILE_BYTES = 4096;
/** core reviews.ts MAX_REVIEW_SOCKET_PATH_LENGTH: a socket path the server could have recorded. */
const MAX_SOCKET_PATH_LENGTH = 512;
const MAX_PROJECT_PATH_LENGTH = 4096;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
export const PROJECT_KEY_RE = /^[a-z0-9._-]{1,64}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_AGE_RE = /^([1-9]\d{0,6})(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The options `relay` and `relay-service install` share (node:util parseArgs). */
export const RELAY_CONFIG_OPTIONS = {
  project: { type: "string", multiple: true },
  kinds: { type: "string" },
  "herdr-socket": { type: "string", multiple: true },
  "max-age": { type: "string" },
};

/** herdr's own default server socket for the user whose home is `homedir` (apps/web/server/herdr-session.ts `resolveHerdrSocket`). */
export function defaultHerdrSocket(homedir = os.homedir()) {
  return path.join(homedir, ".config", "herdr", "herdr.sock");
}

/** Whether an http origin's host keeps the traffic off untrusted networks (module header). */
export function isPrivateHttpHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  if (host.endsWith(".ts.net") && host.length > ".ts.net".length) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/** `--url`'s origin, or an error naming what is wrong with it. */
export function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `--url is not a URL: ${value}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `--url must be http or https, got ${url.protocol.replace(/:$/, "")}` };
  if (url.username !== "" || url.password !== "") return { error: "--url must not carry credentials; the token goes in --token-file" };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return { error: `--url must be an origin with no path, query, or fragment (like https://jetson.tail1234.ts.net), got ${value}` };
  }
  if (url.protocol === "http:" && !isPrivateHttpHost(url.hostname)) {
    return { error: `--url ${url.origin} is plain http to a host that is not loopback, a tailnet address (100.64.0.0/10), or a *.ts.net name; the token would cross the network in the clear. Use https.` };
  }
  return { origin: url.origin };
}

/** One `--project key=/abs/path`, or why it is not one. */
export function parseProjectFlag(value) {
  const at = value.indexOf("=");
  if (at <= 0) return { error: `--project must be <key>=<absolute path> (like bd=/Users/me/dev/bd), got ${JSON.stringify(value)}` };
  const key = value.slice(0, at);
  const dir = value.slice(at + 1);
  if (!PROJECT_KEY_RE.test(key)) return { error: `--project's key must match [a-z0-9._-]{1,64}, got ${JSON.stringify(key)}` };
  if (!path.isAbsolute(dir)) return { error: `--project ${key}'s path must be absolute, got ${JSON.stringify(dir)}` };
  if (dir.length > MAX_PROJECT_PATH_LENGTH || CONTROL_CHAR.test(dir)) return { error: `--project ${key}'s path must be at most ${MAX_PROJECT_PATH_LENGTH} characters with no control characters` };
  if (path.normalize(dir) !== dir || (dir.length > 1 && dir.endsWith(path.sep))) {
    return { error: `--project ${key}'s path must be written as its real path, with no trailing slash, "." or ".." (got ${JSON.stringify(dir)})` };
  }
  return { project: { key, path: dir } };
}

/** `--kinds`, or why it is not a list of kinds. */
export function parseKinds(value) {
  const kinds = [];
  for (const kind of value.split(",").map((k) => k.trim())) {
    if (!RELAY_KINDS.includes(kind)) return { error: `--kinds must list kinds from ${RELAY_KINDS.join(", ")}, comma-separated; got ${JSON.stringify(kind)}` };
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { kinds };
}

/** One `--herdr-socket`, or why it cannot be one. */
export function parseHerdrSocket(value) {
  if (!path.isAbsolute(value) || value.length > MAX_SOCKET_PATH_LENGTH || CONTROL_CHAR.test(value)) {
    return { error: `--herdr-socket must be an absolute path of at most ${MAX_SOCKET_PATH_LENGTH} characters with no control characters, got ${JSON.stringify(value)}` };
  }
  if (path.normalize(value) !== value) return { error: `--herdr-socket must be written as the socket's own path, with no "." or ".." (got ${JSON.stringify(value)})` };
  return { socket: value };
}

/** `--max-age`, in milliseconds. */
export function parseMaxAge(value) {
  const m = MAX_AGE_RE.exec(value);
  if (m === null) return { error: `--max-age must be a whole number of s, m, h, or d (like 24h), got ${JSON.stringify(value)}` };
  return { ms: Number(m[1]) * UNIT_MS[m[2]] };
}

/**
 * The shared configuration flags (RELAY_CONFIG_OPTIONS' values), checked.
 * `explicit` keeps only what was given, for writing back into a plist.
 *
 * @returns {{ error: string } | {
 *   projects: { key: string, path: string }[], kinds: string[], herdrSockets: string[], maxAgeMs: number,
 *   explicit: { kinds: string | null, herdrSockets: string[], maxAge: string | null }
 * }}
 */
export function parseRelayConfig(values, { homedir = os.homedir() } = {}) {
  const projects = [];
  for (const raw of values.project ?? []) {
    const parsed = parseProjectFlag(raw);
    if ("error" in parsed) return parsed;
    const same = projects.find((p) => p.key === parsed.project.key);
    if (same !== undefined && same.path !== parsed.project.path) return { error: `--project ${parsed.project.key} is given twice with different paths` };
    if (same === undefined) projects.push(parsed.project);
  }
  if (projects.length === 0) return { error: "--project <key>=<absolute path> is required (at least one): the relay runs bd only in checkouts named here" };
  let kinds = [...RELAY_KINDS];
  if (values.kinds !== undefined) {
    const parsed = parseKinds(values.kinds);
    if ("error" in parsed) return parsed;
    kinds = parsed.kinds;
  }
  const given = [];
  for (const raw of values["herdr-socket"] ?? []) {
    const parsed = parseHerdrSocket(raw);
    if ("error" in parsed) return parsed;
    if (!given.includes(parsed.socket)) given.push(parsed.socket);
  }
  let maxAgeMs = parseMaxAge(DEFAULT_MAX_AGE).ms;
  if (values["max-age"] !== undefined) {
    const parsed = parseMaxAge(values["max-age"]);
    if ("error" in parsed) return parsed;
    maxAgeMs = parsed.ms;
  }
  return {
    projects,
    kinds,
    herdrSockets: given.length > 0 ? given : [defaultHerdrSocket(homedir)],
    maxAgeMs,
    explicit: { kinds: values.kinds === undefined ? null : kinds.join(","), herdrSockets: given, maxAge: values["max-age"] ?? null },
  };
}

/**
 * @returns {{ help: true } | { error: string }
 *   | { origin: string, tokenFile: string, name: string, projects: { key: string, path: string }[],
 *       kinds: string[], herdrSockets: string[], maxAgeMs: number }}
 */
export function parseRelayArgs(argv, { homedir = os.homedir() } = {}) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        url: { type: "string" },
        "token-file": { type: "string" },
        name: { type: "string" },
        ...RELAY_CONFIG_OPTIONS,
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values } = parsed;
  if (values.help) return { help: true };
  for (const flag of ["url", "token-file", "name"]) {
    if (values[flag] === undefined || values[flag] === "") return { error: `--${flag} is required` };
  }
  const origin = parseOrigin(values.url);
  if ("error" in origin) return origin;
  const tokenFile = values["token-file"];
  if (!path.isAbsolute(tokenFile)) return { error: `--token-file must be an absolute path, got ${tokenFile}` };
  const name = values.name;
  if (!NAME_RE.test(name)) return { error: `--name must be a client name (a letter or digit, then letters, digits, . _ @ : -; at most 200), got ${JSON.stringify(name)}` };
  const config = parseRelayConfig(values, { homedir });
  if ("error" in config) return config;
  const { projects, kinds, herdrSockets, maxAgeMs } = config;
  return { origin: origin.origin, tokenFile: path.normalize(tokenFile), name, projects, kinds, herdrSockets, maxAgeMs };
}

/**
 * Why `dir` cannot be one of the relay's checkouts, or null when it can: its
 * realpath is itself (no symlink anywhere along it), it is a directory, and
 * it holds a `.beads/` directory. The relay checks the same before every
 * `bd` it spawns (apps/web/server/relay/registry.ts `checkoutProblem`);
 * install checks it here so a wrong path is refused before launchd runs it.
 */
export function checkoutProblem(dir) {
  if (!path.isAbsolute(dir)) return "is not an absolute path";
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch {
    return "does not exist on this machine";
  }
  if (real !== dir) return `resolves to ${real} (a symlink or a non-canonical spelling); give the real path`;
  try {
    if (!fs.statSync(dir).isDirectory()) return "is not a directory";
    if (!fs.lstatSync(path.join(dir, ".beads")).isDirectory()) return "has no .beads/ directory";
  } catch {
    return "has no .beads/ directory";
  }
  return null;
}

export class TokenFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenFileError";
  }
}

const octal = (mode) => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;

/**
 * Why `file` cannot be the token file, or null. `stat` is the open
 * descriptor's fstat (or an lstat: a symlink is refused, never followed);
 * `uid` the relay's own.
 */
export function tokenFileProblem(file, stat, uid) {
  if (stat.isSymbolicLink()) return `${file} is a symlink; point --token-file at the file itself`;
  if (!stat.isFile()) return `${file} is not a regular file`;
  if (uid !== undefined && stat.uid !== uid) return `${file} is owned by uid ${stat.uid}, not by you (uid ${uid}); the token file must be your own`;
  if ((stat.mode & 0o077) !== 0) return `${file} has mode ${octal(stat.mode)}, readable or writable by others; run: chmod 600 ${file}`;
  return null;
}

/** The token in `text`, or why it is not one (never quoting it). */
export function parseTokenText(file, text) {
  const token = text.trim();
  if (token === "") return { error: `${file} is empty; write the token printed by \`pnpm -s client-token create <name> --scope relay\` into it` };
  if (token.length > MAX_TOKEN_LENGTH) return { error: `${file} holds ${token.length} characters; a token is at most ${MAX_TOKEN_LENGTH}` };
  if (/\s/.test(token)) return { error: `${file} must hold one token on one line, with no spaces inside` };
  return { token };
}

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/**
 * Reads the token file after checking it on its open descriptor (module
 * header). Throws TokenFileError naming the path and the problem; never the
 * contents. `deps.uid` replaces the relay's uid (tests).
 */
export function readTokenFile(file, deps = {}) {
  const uid = "uid" in deps ? deps.uid : process.getuid?.();
  let fd;
  try {
    // O_NONBLOCK: a FIFO planted at the path answers at once rather than hanging the open; fstat refuses it below.
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch (err) {
    if (err?.code === "ENOENT") throw new TokenFileError(`token file ${file} does not exist; create it with mode 0600 and the relay token in it`);
    if (err?.code === "ELOOP" || err?.code === "EMLINK") throw new TokenFileError(`token file ${file} is a symlink; point --token-file at the file itself`);
    throw new TokenFileError(`cannot read token file ${file} (${err?.code ?? "error"})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    const problem = tokenFileProblem(file, stat, uid);
    if (problem !== null) throw new TokenFileError(`token file ${problem}`);
    if (stat.size > MAX_TOKEN_FILE_BYTES) throw new TokenFileError(`token file ${file} holds ${stat.size} bytes; a token file is at most ${MAX_TOKEN_FILE_BYTES}`);
    let text;
    try {
      text = fs.readFileSync(fd, "utf8");
    } catch (err) {
      throw new TokenFileError(`cannot read token file ${file} (${err?.code ?? "error"})`);
    }
    const parsed = parseTokenText(file, text);
    if ("error" in parsed) throw new TokenFileError(`token file ${parsed.error}`);
    return parsed.token;
  } finally {
    fs.closeSync(fd);
  }
}
