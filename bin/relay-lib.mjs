// relay: the pure parts of the laptop relay's command line (laptop-relay
// design.md decisions 7 and 9): its flags and its token file. Plain Node
// ESM with no workspace imports, so bin/relay.mjs can refuse a bad start
// before loading the relay itself, and bin/relay-service-lib.mjs checks
// the same things at install.
//
// The token file is the relay's own secret, never an environment variable
// a server reads. It must be a regular file (not a symlink, which could be
// re-pointed), owned by the user running the relay, readable by that user
// alone (no group or other bits), and hold one token: a single line of 1 to
// 512 characters with no whitespace inside. A refusal names the path and
// what is wrong — the mode in octal, with the chmod that fixes it — and
// never the file's contents.

import fs from "node:fs";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const RELAY_USAGE = [
  "usage: relay --url <http(s)://host[:port]> --token-file <absolute path> --name <client> [--project <key>]...",
  "  --url         the Breakdown web server (its origin: no path, query, or credentials)",
  "  --token-file  a file holding the relay-scoped token, mode 0600 (pnpm -s client-token create <name> --scope relay)",
  "  --name        this relay's client name, as minted (for the log)",
  "  --project     watch and run actions only for this registered beads project (repeatable; default: all)",
].join("\n");

export const MAX_TOKEN_LENGTH = 512;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
const PROJECT_KEY_RE = /^[a-z0-9._-]{1,64}$/;

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
  return { origin: url.origin };
}

/**
 * @returns {{ help: true } | { error: string }
 *   | { origin: string, tokenFile: string, name: string, projects: string[] }}
 */
export function parseRelayArgs(argv) {
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
        project: { type: "string", multiple: true },
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
  const projects = [];
  for (const key of values.project ?? []) {
    if (!PROJECT_KEY_RE.test(key)) return { error: `--project must be a project key matching [a-z0-9._-]{1,64}, got ${JSON.stringify(key)}` };
    if (!projects.includes(key)) projects.push(key);
  }
  return { origin: origin.origin, tokenFile: path.normalize(tokenFile), name, projects };
}

export class TokenFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenFileError";
  }
}

const octal = (mode) => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;

/**
 * Why `file` cannot be the token file, or null. `stat` is an lstat result
 * (a symlink is refused, never followed); `uid` the relay's own.
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

/**
 * Reads the token file after checking it (module header). Throws
 * TokenFileError naming the path and the problem; never the contents.
 * `deps` replaces fs and the uid (tests).
 */
export function readTokenFile(file, deps = {}) {
  const lstat = deps.lstat ?? fs.lstatSync;
  const readFile = deps.readFile ?? ((f) => fs.readFileSync(f, "utf8"));
  const uid = "uid" in deps ? deps.uid : process.getuid?.();
  let stat;
  try {
    stat = lstat(file);
  } catch (err) {
    if (err?.code === "ENOENT") throw new TokenFileError(`token file ${file} does not exist; create it with mode 0600 and the relay token in it`);
    throw new TokenFileError(`cannot read token file ${file} (${err?.code ?? "error"})`);
  }
  const problem = tokenFileProblem(file, stat, uid);
  if (problem !== null) throw new TokenFileError(`token file ${problem}`);
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    throw new TokenFileError(`cannot read token file ${file} (${err?.code ?? "error"})`);
  }
  const parsed = parseTokenText(file, text);
  if ("error" in parsed) throw new TokenFileError(`token file ${parsed.error}`);
  return parsed.token;
}
