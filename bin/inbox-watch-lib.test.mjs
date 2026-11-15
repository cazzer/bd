import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPrompt,
  checkApiTrust,
  claudeArgs,
  decisionTime,
  isLoopbackHost,
  MAX_IDS_PER_RUN,
  parseInboxResponse,
  parseWatchArgs,
  remoteWarning,
  resolveApi,
  sanitizeForLog,
  selectDue,
} from "./inbox-watch-lib.mjs";

const ID_A = "0b6c3a1e-2f4d-4c8a-9e1b-7d5f3a2c1b0e";
const ID_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rawItem(overrides = {}) {
  return { id: ID_A, title: "Reply to Robin", status: "accepted", pane: null, hangarSession: null, updatedAt: "2026-11-14T12:00:00.000Z", feedback: [], ...overrides };
}
function body(items) {
  return { result: { data: { items } } };
}
function item(overrides = {}) {
  return { id: ID_A, status: "accepted", owned: false, updatedAt: "2026-11-14T12:00:00.000Z", feedback: [], ...overrides };
}

describe("isLoopbackHost", () => {
  for (const host of ["127.0.0.1", "127.255.0.9", "localhost", "LOCALHOST", "[::1]"]) it(`accepts ${host}`, () => assert.equal(isLoopbackHost(host), true));
  for (const host of ["100.64.0.1", "jetson.tail1.ts.net", "128.0.0.1", "localhost.", "[::ffff:7f00:1]", "example.com"]) it(`refuses ${host}`, () => assert.equal(isLoopbackHost(host), false));
});

describe("resolveApi", () => {
  it("defaults to the local server when unset or empty", () => {
    assert.deepEqual(resolveApi({}), { api: "http://127.0.0.1:4310" });
    assert.deepEqual(resolveApi({ BREAKDOWN_API: "", WEB_SERVER_PORT: "5999" }), { api: "http://127.0.0.1:5999" });
  });
  it("drops trailing slashes and keeps a path prefix", () => {
    assert.deepEqual(resolveApi({ BREAKDOWN_API: "https://x.tail1.ts.net/" }), { api: "https://x.tail1.ts.net" });
    assert.deepEqual(resolveApi({ BREAKDOWN_API: "http://127.0.0.1:4310/api//" }), { api: "http://127.0.0.1:4310/api" });
  });
  it("refuses a URL that is not http(s)", () => {
    assert.match(resolveApi({ BREAKDOWN_API: "ftp://host" }).error, /http\(s\)/);
    assert.match(resolveApi({ BREAKDOWN_API: "not a url" }).error, /http\(s\)/);
  });
});

describe("checkApiTrust", () => {
  it("lets loopback through without the flag", () => {
    assert.deepEqual(checkApiTrust("http://127.0.0.1:4310", { allowRemote: false }), { remote: false });
    assert.deepEqual(checkApiTrust("http://127.1:4310", { allowRemote: false }), { remote: false });
    assert.deepEqual(checkApiTrust("http://[::1]:4310", { allowRemote: false }), { remote: false });
  });
  it("refuses a remote host without --allow-remote", () => {
    const result = checkApiTrust("https://jetson.tail1.ts.net", { allowRemote: false });
    assert.match(result.error, /jetson\.tail1\.ts\.net/);
    assert.match(result.error, /--allow-remote/);
    assert.match(result.error, /docs\/relay\.md#what-the-relay-trusts/);
    assert.ok("error" in checkApiTrust("http://100.100.1.2:4310", { allowRemote: false }));
  });
  it("allows https and tailnet http with the flag", () => {
    assert.deepEqual(checkApiTrust("https://example.com", { allowRemote: true }), { remote: true });
    assert.deepEqual(checkApiTrust("http://jetson.tail1.ts.net", { allowRemote: true }), { remote: true });
    assert.deepEqual(checkApiTrust("http://100.100.1.2:4310", { allowRemote: true }), { remote: true });
  });
  it("refuses cleartext http off the tailnet even with the flag", () => {
    assert.match(checkApiTrust("http://example.com", { allowRemote: true }).error, /in the clear/);
    assert.match(checkApiTrust("http://192.168.1.5:4310", { allowRemote: true }).error, /in the clear/);
  });
  it("refuses credentials in the URL", () => {
    assert.match(checkApiTrust("https://u:p@example.com", { allowRemote: true }).error, /credentials/);
  });
});

describe("remoteWarning", () => {
  it("is one line naming the server, the age, and the trust doc, with a hint when no token is set", () => {
    const warned = remoteWarning("https://x.tail1.ts.net", "/repo", "24h", { hasToken: true });
    assert.doesNotMatch(warned, /\n/);
    assert.match(warned, /REMOTE/);
    assert.match(warned, /x\.tail1\.ts\.net/);
    assert.match(warned, /24h/);
    assert.match(warned, /what-the-relay-trusts/);
    assert.doesNotMatch(warned, /BREAKDOWN_TOKEN/);
    assert.match(remoteWarning("https://x.tail1.ts.net", "/repo", "24h", { hasToken: false }), /BREAKDOWN_TOKEN/);
  });
});

describe("parseWatchArgs", () => {
  it("has defaults", () => {
    assert.deepEqual(parseWatchArgs([]), { intervalMs: 30_000, once: false, dryRun: false, allowRemote: false, maxAgeMs: DAY, maxAge: "24h" });
  });
  it("reads the flags", () => {
    const parsed = parseWatchArgs(["--interval", "60", "--once", "--dry-run", "--allow-remote", "--max-age", "2h"]);
    assert.deepEqual(parsed, { intervalMs: 60_000, once: true, dryRun: true, allowRemote: true, maxAgeMs: 7_200_000, maxAge: "2h" });
  });
  it("refuses a bad --interval", () => {
    for (const value of ["5", "abc", "1.5", "", "-30"]) assert.match(parseWatchArgs([`--interval=${value}`]).error, /--interval/, value);
  });
  it("refuses a bad --max-age", () => {
    assert.match(parseWatchArgs(["--max-age", "2x"]).error, /--max-age/);
  });
  it("refuses an unknown flag or a positional", () => {
    assert.ok("error" in parseWatchArgs(["--bogus"]));
    assert.ok("error" in parseWatchArgs(["now"]));
  });
  it("answers --help", () => {
    assert.deepEqual(parseWatchArgs(["--help"]), { help: true });
  });
});

describe("parseInboxResponse", () => {
  it("errors when there is no items list", () => {
    assert.ok("error" in parseInboxResponse({}));
    assert.ok("error" in parseInboxResponse(null));
    assert.ok("error" in parseInboxResponse(body("nope")));
    assert.ok("error" in parseInboxResponse({ result: { data: {} } }));
  });
  it("keeps well-formed entries without their text", () => {
    const parsed = parseInboxResponse(body([rawItem(), rawItem({ id: ID_B, status: "changes", pane: "p1", hangarSession: undefined })]));
    assert.equal(parsed.dropped, 0);
    assert.deepEqual(parsed.items, [
      { id: ID_A, status: "accepted", owned: false, updatedAt: "2026-11-14T12:00:00.000Z", feedback: [] },
      { id: ID_B, status: "changes", owned: true, updatedAt: "2026-11-14T12:00:00.000Z", feedback: [] },
    ]);
    assert.doesNotMatch(JSON.stringify(parsed), /Robin/);
  });
  it("marks a hangar session's item as owned", () => {
    assert.equal(parseInboxResponse(body([rawItem({ hangarSession: ID_B })])).items[0].owned, true);
  });
  it("drops and counts malformed entries", () => {
    const bad = [
      rawItem({ id: "1; rm -rf ~" }),
      rawItem({ id: ID_A.toUpperCase() }),
      rawItem({ id: 7 }),
      rawItem({ status: "pending" }),
      rawItem({ status: "done" }),
      rawItem({ updatedAt: undefined }),
      rawItem({ pane: 3 }),
      rawItem({ pane: undefined }),
      rawItem({ hangarSession: 4 }),
      "string",
      null,
      [ID_A],
    ];
    const parsed = parseInboxResponse(body([...bad, rawItem()]));
    assert.equal(parsed.dropped, bad.length);
    assert.deepEqual(parsed.items.map((i) => i.id), [ID_A]);
  });
  it("treats a non-array feedback as none", () => {
    assert.deepEqual(parseInboxResponse(body([rawItem({ feedback: { decision: "accept" } })])).items[0].feedback, []);
  });
});

describe("decisionTime", () => {
  it("takes the latest entry matching the status, not a later session or release", () => {
    const feedback = [
      { decision: "accept", message: "", at: "2026-11-10T00:00:00.000Z" },
      { decision: "changes", message: "x", at: "2026-11-11T00:00:00.000Z" },
      { decision: "accept", message: "", at: "2026-11-12T00:00:00.000Z" },
      { decision: "session", message: "", at: "2026-11-13T00:00:00.000Z" },
      { decision: "release", message: "", at: "2026-11-13T06:00:00.000Z" },
    ];
    assert.equal(decisionTime(item({ feedback })), Date.parse("2026-11-12T00:00:00.000Z"));
    assert.equal(decisionTime(item({ status: "changes", feedback })), Date.parse("2026-11-11T00:00:00.000Z"));
  });
  it("falls back to updatedAt when no entry matches", () => {
    assert.equal(decisionTime(item({ feedback: [{ decision: "dismiss", at: "2026-11-01T00:00:00.000Z" }] })), Date.parse("2026-11-14T12:00:00.000Z"));
    assert.equal(decisionTime(item()), Date.parse("2026-11-14T12:00:00.000Z"));
  });
  it("is null when the matching entry's time is unreadable, never falling back", () => {
    assert.equal(decisionTime(item({ feedback: [{ decision: "accept", at: "yesterday-ish" }] })), null);
    assert.equal(decisionTime(item({ feedback: [{ decision: "accept", at: 1731585600000 }] })), null);
    assert.equal(decisionTime(item({ feedback: [{ decision: "accept" }] })), null);
  });
  it("is null when there is no feedback and updatedAt is unreadable", () => {
    assert.equal(decisionTime(item({ updatedAt: "garbage" })), null);
  });
});

describe("selectDue", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const opts = (tried = new Set()) => ({ status: "accepted", now, maxAgeMs: DAY, tried });

  it("runs an item decided within the window, up to exactly the limit", () => {
    const fresh = item({ updatedAt: at(DAY - 60_000) });
    const edge = item({ id: ID_B, updatedAt: at(DAY) });
    assert.deepEqual(selectDue([fresh, edge], opts()), { due: [fresh, edge], stale: [] });
  });
  it("skips an item decided longer ago, saying when", () => {
    const old = item({ updatedAt: at(DAY + 60_000) });
    const { due, stale } = selectDue([old], opts());
    assert.deepEqual(due, []);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].item, old);
    assert.match(stale[0].reason, /decided 2026-11-13T11:59:00\.000Z, older than --max-age 1d/);
    assert.match(selectDue([old], { ...opts(), maxAge: "24h" }).stale[0].reason, /older than --max-age 24h$/);
  });
  it("judges age by the decision, not updatedAt", () => {
    const old = item({ updatedAt: at(0), feedback: [{ decision: "accept", at: at(2 * DAY) }] });
    assert.equal(selectDue([old], opts()).stale.length, 1);
  });
  it("counts a future decision as fresh", () => {
    const future = item({ updatedAt: new Date(now + HOUR).toISOString() });
    assert.deepEqual(selectDue([future], opts()).due, [future]);
  });
  it("skips an unreadable time as stale", () => {
    const { due, stale } = selectDue([item({ updatedAt: "garbage" })], opts());
    assert.deepEqual(due, []);
    assert.equal(stale[0].reason, "no readable decision time");
  });
  it("leaves owned, tried, and other-status items out of both lists, and does not change tried", () => {
    const owned = item({ owned: true });
    const triedItem = item({ id: ID_B });
    const changes = item({ status: "changes" });
    const tried = new Set([`${ID_B}@${triedItem.updatedAt}`]);
    assert.deepEqual(selectDue([owned, triedItem, changes], opts(tried)), { due: [], stale: [] });
    assert.equal(tried.size, 1);
  });
});

describe("buildPrompt", () => {
  it("names the ids and restricts the run to them", () => {
    const prompt = buildPrompt("accepted", [ID_A, ID_B]);
    assert.ok(prompt.includes(`${ID_A}, ${ID_B}`));
    assert.match(prompt, /brain_get/);
    assert.match(prompt, /no others/);
    assert.match(prompt, /status `accepted`/);
    assert.doesNotMatch(prompt, /Robin/);
  });
  it("points a changes run at Triage", () => {
    const prompt = buildPrompt("changes", [ID_A]);
    assert.match(prompt, /Triage/);
    assert.match(prompt, /status `changes`/);
    assert.match(prompt, /no others/);
    assert.match(prompt, /brain_get/);
  });
  it("throws on no ids, a non-UUID id, too many ids, or an unknown status", () => {
    assert.throws(() => buildPrompt("accepted", []));
    assert.throws(() => buildPrompt("accepted", ["1; rm -rf ~"]));
    assert.throws(() => buildPrompt("accepted", [ID_A.toUpperCase()]));
    assert.throws(() => buildPrompt("accepted", Array.from({ length: MAX_IDS_PER_RUN + 1 }, () => ID_A)));
    assert.doesNotThrow(() => buildPrompt("accepted", Array.from({ length: MAX_IDS_PER_RUN }, () => ID_A)));
    assert.throws(() => buildPrompt("pending", [ID_A]));
  });
});

describe("claudeArgs", () => {
  it("is today's argv on loopback", () => {
    assert.deepEqual(claudeArgs("P", { remote: false }), ["-p", "P", "--mcp-config", ".mcp.json", "--permission-mode", "bypassPermissions"]);
  });
  it("denies shell and file tools in remote mode, after the prompt", () => {
    const args = claudeArgs("P", { remote: true });
    assert.deepEqual(args, ["-p", "P", "--mcp-config", ".mcp.json", "--disallowedTools", "Bash,Edit,Write,NotebookEdit", "--permission-mode", "bypassPermissions"]);
    assert.equal(args[1], "P");
    assert.equal(args.indexOf("--disallowedTools") + 2, args.indexOf("--permission-mode"));
  });
});

describe("sanitizeForLog", () => {
  it("strips control characters", () => {
    const clean = sanitizeForLog("\u001b[31mbad\nline\r\u0007");
    assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f]/);
    assert.match(clean, /bad line/);
  });
  it("truncates", () => {
    assert.equal(sanitizeForLog("x".repeat(500)).length, 301);
    assert.equal(sanitizeForLog("abcdef", 3), "abc…");
  });
});
