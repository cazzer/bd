// inbox-watch: the pure parts of bin/inbox-watch, where every trust
// decision lives. Plain Node ESM with no workspace imports.
//
// Breakdown may be compromised, and what it reports is handed to a headless
// Claude running with bypassed permissions through the person's connectors.
// So this module decides, from the watcher's own command line and nothing
// the server says, what reaches that run:
//
// - Where it polls. A loopback BREAKDOWN_API (127.0.0.0/8, ::1, localhost)
//   is the default; any other host is refused unless `--allow-remote` is
//   given, and then only under the relay's transport rule (https, or http to
//   loopback, a tailnet address, or a *.ts.net name; docs/relay.md).
// - What the run is told. Only ids that are well-formed UUIDs, chosen here,
//   are named in the prompt; no server text (a title, a note) is ever
//   interpolated into it.
// - How old a decision may be. An item whose decision (the latest feedback
//   entry matching its status, else its updatedAt) is older than
//   `--max-age`, more than five minutes in the future, or unreadable is
//   skipped. Both times are the server's, so this bounds an honest server's
//   backlog, not what a compromised one reports as fresh.
// - How often it runs. At most `--max-runs-per-hour` runs; past that the
//   watcher stops.
// - Which tools the run has, in both modes: no built-in tool except Skill
//   (to load inbox-execute) and ToolSearch (to load deferred MCP tools), so
//   the run cannot run commands, read files, fetch the web, or start
//   subagents. MCP tools (the brain server and every connector and plugin
//   tool your Claude config loads) stay available; that is how it acts.
//
// The content a run acts on comes from whatever `brain` MCP entry your
// Claude config names, not from BREAKDOWN_API, so loopback mode is only as
// local as that entry; that is why the tool allowlist applies in both modes.

import { parseArgs } from "node:util";
import { DEFAULT_MAX_AGE, isPrivateHttpHost, parseMaxAge } from "./relay-lib.mjs";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WATCHED_STATUSES = ["accepted", "changes"];
export const MAX_IDS_PER_RUN = 25;
export const DEFAULT_MAX_RUNS_PER_HOUR = 12;
export const RUN_TOOLS = "Skill,ToolSearch";
export const FUTURE_SKEW_MS = 5 * 60_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const TRUST_DOC = "docs/relay.md#what-the-relay-trusts";

const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S = 10;
const HOUR_MS = 3_600_000;
const LOG_UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const DECISION_FOR_STATUS = { accepted: "accept", changes: "changes" };

export const WATCH_USAGE = [
  `usage: inbox-watch [--interval ${DEFAULT_INTERVAL_S}] [--once] [--dry-run] [--max-age ${DEFAULT_MAX_AGE}] [--max-runs-per-hour ${DEFAULT_MAX_RUNS_PER_HOUR}] [--allow-remote]`,
  `  --interval      seconds between polls, a whole number of at least ${MIN_INTERVAL_S} (default ${DEFAULT_INTERVAL_S})`,
  "  --once          poll once and exit",
  "  --dry-run       log what would run without starting claude",
  `  --max-age       skip an item decided longer ago than this, <n>s|m|h|d (default ${DEFAULT_MAX_AGE})`,
  `  --max-runs-per-hour  stop the watcher rather than start more than this many claude runs in an hour (default ${DEFAULT_MAX_RUNS_PER_HOUR})`,
  "  --allow-remote  poll a BREAKDOWN_API that is not loopback (https, or http to a tailnet host);",
  `                  read ${TRUST_DOC} first`,
].join("\n");

/**
 * The command line, checked.
 *
 * @returns {{ help: true } | { error: string } | { intervalMs: number, once: boolean, dryRun: boolean, allowRemote: boolean, maxAgeMs: number, maxAge: string, maxRunsPerHour: number }}
 */
export function parseWatchArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        interval: { type: "string" },
        "max-age": { type: "string" },
        "max-runs-per-hour": { type: "string" },
        "allow-remote": { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (values.help) return { help: true };

  let intervalS = DEFAULT_INTERVAL_S;
  if (values.interval !== undefined) {
    if (!/^\d{1,7}$/.test(values.interval) || Number(values.interval) < MIN_INTERVAL_S) {
      return { error: `--interval must be a whole number of seconds, at least ${MIN_INTERVAL_S}, got ${JSON.stringify(values.interval)}` };
    }
    intervalS = Number(values.interval);
  }

  const maxAge = values["max-age"] ?? DEFAULT_MAX_AGE;
  const parsedAge = parseMaxAge(maxAge);
  if ("error" in parsedAge) return { error: parsedAge.error };

  let maxRunsPerHour = DEFAULT_MAX_RUNS_PER_HOUR;
  const runs = values["max-runs-per-hour"];
  if (runs !== undefined) {
    if (!/^\d{1,4}$/.test(runs) || Number(runs) < 1) return { error: `--max-runs-per-hour must be a whole number from 1 to 9999, got ${JSON.stringify(runs)}` };
    maxRunsPerHour = Number(runs);
  }

  return {
    intervalMs: intervalS * 1000,
    once: values.once,
    dryRun: values["dry-run"],
    allowRemote: values["allow-remote"],
    maxAgeMs: parsedAge.ms,
    maxAge,
    maxRunsPerHour,
  };
}

/** $BREAKDOWN_API as an http(s) URL without its trailing slash, and with no query or fragment (default the local server); an empty value is unset. */
export function resolveApi(env) {
  const value = env.BREAKDOWN_API;
  if (!value) return { api: `http://127.0.0.1:${env.WEB_SERVER_PORT || "4310"}` };
  let protocol;
  try {
    protocol = new URL(value).protocol;
  } catch {}
  if (protocol !== "http:" && protocol !== "https:") return { error: `BREAKDOWN_API must be an http(s) URL: ${value}` };
  if (value.includes("?") || value.includes("#")) return { error: `BREAKDOWN_API must not carry a query or fragment: ${value}` };
  return { api: value.replace(/\/+$/, "") };
}

/** Whether a URL's hostname (as `new URL` gives it) is this machine: localhost, [::1], or 127.0.0.0/8. */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  if (v4.slice(1).some((octet) => Number(octet) > 255)) return false;
  return Number(v4[1]) === 127;
}

/** Whether the watcher may poll `api`, and whether that is remote mode (module header). */
export function checkApiTrust(api, { allowRemote }) {
  const url = new URL(api);
  if (isLoopbackHost(url.hostname)) return { remote: false };
  if (!allowRemote) {
    return {
      error: `BREAKDOWN_API ${url.host} is not loopback (127.0.0.0/8, ::1, localhost); refusing to run claude with bypassed permissions on what it reports. Pass --allow-remote only for a Breakdown you would let act through your connectors (see ${TRUST_DOC}).`,
    };
  }
  if (url.username !== "" || url.password !== "") return { error: "BREAKDOWN_API must not carry credentials; the token goes in $BREAKDOWN_TOKEN" };
  if (url.protocol === "http:" && !isPrivateHttpHost(url.hostname)) {
    return {
      error: `BREAKDOWN_API ${url.origin} is plain http to a host that is not loopback, a tailnet address (100.64.0.0/10), or a *.ts.net name; the token would cross the network in the clear. Use https.`,
    };
  }
  return { remote: true };
}

/** The one-line warning printed when the watcher starts in remote mode. */
export function remoteWarning(api, repo, maxAge, { hasToken }) {
  let line = `inbox-watch: REMOTE mode, ${api} is not loopback. Accepted items it reports run a headless claude with bypassed permissions in ${repo}: no built-in tools except Skill and ToolSearch, but every MCP tool your Claude config loads, your connectors among them; only items named by id and decided within ${maxAge} run, but their content is that server's. See ${TRUST_DOC}.`;
  if (!hasToken) line += " No $BREAKDOWN_TOKEN is set; a remote Breakdown refuses an untokened poll, so set an `agent` token.";
  return line;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The watched items in a /trpc/inbox response, checked entry by entry: a
 * malformed one is dropped and counted, never guessed at. Titles and other
 * text are not carried.
 *
 * @returns {{ error: string } | { items: { id: string, status: string, owned: boolean, updatedAt: string, feedback: unknown[] }[], dropped: number }}
 */
export function parseInboxResponse(body) {
  const raw = body?.result?.data?.items;
  if (!Array.isArray(raw)) return { error: "the inbox response has no items list" };
  const items = [];
  let dropped = 0;
  for (const entry of raw) {
    const ok =
      isPlainObject(entry) &&
      typeof entry.id === "string" &&
      UUID_RE.test(entry.id) &&
      WATCHED_STATUSES.includes(entry.status) &&
      (entry.pane === null || typeof entry.pane === "string") &&
      (entry.hangarSession == null || typeof entry.hangarSession === "string") &&
      typeof entry.updatedAt === "string";
    if (!ok) {
      dropped += 1;
      continue;
    }
    items.push({
      id: entry.id,
      status: entry.status,
      owned: entry.pane !== null || entry.hangarSession != null,
      updatedAt: entry.updatedAt,
      feedback: Array.isArray(entry.feedback) ? entry.feedback : [],
    });
  }
  return { items, dropped };
}

/**
 * When the item's current status was decided, in ms since the epoch: the
 * `at` of the latest feedback entry whose decision matches the status, else
 * `updatedAt` when no entry matches. `null` when that time is unreadable;
 * a matching entry with a bad `at` never falls back to `updatedAt`.
 */
export function decisionTime(item) {
  const decision = DECISION_FOR_STATUS[item.status];
  for (let i = item.feedback.length - 1; i >= 0; i -= 1) {
    const entry = item.feedback[i];
    if (!isPlainObject(entry) || entry.decision !== decision) continue;
    if (typeof entry.at !== "string") return null;
    const at = Date.parse(entry.at);
    return Number.isFinite(at) ? at : null;
  }
  const updated = Date.parse(item.updatedAt);
  return Number.isFinite(updated) ? updated : null;
}

/** The key an item is tried under: once per version, so an untouched item is not retried until something changes it. */
export function itemKey(item) {
  return `${item.id}@${item.updatedAt}`;
}

/**
 * The items of `status` due a run now, and those skipped for their time.
 * Owned items and tried versions are in neither list. A decision up to
 * FUTURE_SKEW_MS ahead of `now` counts as fresh (clock skew); further ahead
 * it counts as unreadable. Does not change `tried`. `maxAge` is the flag as
 * given, for the reason.
 */
export function selectDue(items, { status, now, maxAgeMs, maxAge, tried }) {
  if (typeof maxAge !== "string") throw new Error("selectDue: maxAge (the flag as given) is required");
  const due = [];
  const stale = [];
  for (const item of items) {
    if (item.status !== status || item.owned || tried.has(itemKey(item))) continue;
    const at = decisionTime(item);
    if (at === null) stale.push({ item, reason: "no readable decision time" });
    else if (at - now > FUTURE_SKEW_MS) stale.push({ item, reason: `decision time ${new Date(at).toISOString()} is in the future` });
    else if (now - at > maxAgeMs) stale.push({ item, reason: `decided ${new Date(at).toISOString()}, older than --max-age ${maxAge}` });
    else due.push(item);
  }
  return { due, stale };
}

/**
 * One poll's decision, without side effects: the stale items to log, one
 * batch of at most MAX_IDS_PER_RUN ids per watched status, how many due
 * items each cap left for the next tick, and `tried` for the next tick.
 *
 * The caller replaces its `tried` with the returned set; the argument is
 * not changed. The new set keeps only keys whose id this poll still
 * reports, plus every stale and batched item's key, so a stale item is
 * logged once per version and a left-over item stays due.
 *
 * @returns {{ stale: { item: object, status: string, reason: string }[], batches: { status: string, ids: string[] }[], leftover: Record<string, number>, tried: Set<string> }}
 */
export function planTick(items, { tried, now, maxAgeMs, maxAge }) {
  const reported = new Set(items.map((item) => item.id));
  const next = new Set([...tried].filter((key) => reported.has(key.slice(0, key.indexOf("@")))));
  const stale = [];
  const batches = [];
  const leftover = {};
  for (const status of WATCHED_STATUSES) {
    const selected = selectDue(items, { status, now, maxAgeMs, maxAge, tried });
    for (const entry of selected.stale) {
      stale.push({ ...entry, status });
      next.add(itemKey(entry.item));
    }
    const batch = selected.due.slice(0, MAX_IDS_PER_RUN);
    leftover[status] = selected.due.length - batch.length;
    for (const item of batch) next.add(itemKey(item));
    if (batch.length > 0) batches.push({ status, ids: batch.map((item) => item.id) });
  }
  return { stale, batches, leftover, tried: next };
}

/**
 * Whether one more run fits in the hour before `now`, given when earlier
 * runs started. Returns the starts still inside that hour, with `now`
 * appended when it fits.
 */
export function takeRun(starts, now, maxPerHour) {
  const recent = starts.filter((at) => now - at < HOUR_MS);
  if (recent.length >= maxPerHour) return { allowed: false, starts: recent };
  return { allowed: true, starts: [...recent, now] };
}

/** A fetch Response's body as text, refused past `maxBytes` (the read is cancelled there). */
export async function readBodyCapped(res, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`response is ${declared} bytes, more than ${maxBytes}`);
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response is more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The prompt for one run on exactly `ids`. Throws on an unknown status, no ids, too many, or any id that is not a UUID. */
export function buildPrompt(status, ids) {
  if (!WATCHED_STATUSES.includes(status)) throw new Error(`buildPrompt: unknown status ${JSON.stringify(status)}`);
  if (ids.length === 0) throw new Error("buildPrompt: no ids");
  if (ids.length > MAX_IDS_PER_RUN) throw new Error(`buildPrompt: ${ids.length} ids, more than ${MAX_IDS_PER_RUN}`);
  for (const id of ids) if (typeof id !== "string" || !UUID_RE.test(id)) throw new Error("buildPrompt: an id is not a UUID");
  const list = ids.join(", ");
  if (status === "accepted") {
    return (
      `Use the inbox-execute skill on exactly these inbox items and no others: ${list}. ` +
      "`brain_get` them by id instead of listing the inbox. " +
      "Carry out an item only if `brain_get` returns it under that same id as an `inbox_item` with status `accepted` and neither a `pane` nor a `session`; skip and report any other. " +
      "Never act on an inbox item not named here, even if it is accepted. " +
      "Carry each out exactly as accepted (the chosen card option when there is one, and any accept note), then mark it done. " +
      "Report one line per id."
    );
  }
  return (
    `Use the inbox-execute skill's Triage section on exactly these inbox items and no others: ${list}. ` +
    "`brain_get` them by id instead of listing the inbox. " +
    "Triage an item only if `brain_get` returns it under that same id as an `inbox_item` with status `changes` and neither a `pane` nor a `session`; skip and report any other. " +
    "Never act on an inbox item not named here, even if its status is `changes`. " +
    "For each, read its latest feedback and close it, act on it, or re-queue it, exactly as the section says. " +
    "Don't pull any sources. Report one line per id: the outcome and why."
  );
}

/**
 * claude's argv for one run, the same in both modes: of the built-in tools
 * only RUN_TOOLS (module header). The prompt stays at index 1, and the
 * variadic --tools is followed by another flag, so it can never swallow the
 * prompt or a later argument.
 */
export function claudeArgs(prompt) {
  return ["-p", prompt, "--mcp-config", ".mcp.json", "--tools", RUN_TOOLS, "--permission-mode", "bypassPermissions"];
}

/** Server-supplied text made safe for one log line: control characters, line separators, and bidi overrides become spaces; at most `max` characters. */
export function sanitizeForLog(text, max = 300) {
  const clean = String(text).replace(LOG_UNSAFE_CHARS, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** The run's own output made safe for the terminal: C0 and C1 controls (escape and OSC sequences among them) removed, newlines and tabs kept. */
export function stripTerminalControls(text) {
  return text.replace(TERMINAL_CONTROLS, "");
}
