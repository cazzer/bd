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
  planTick,
  readBodyCapped,
  remoteWarning,
  resolveApi,
  RUN_TOOLS,
  sanitizeForLog,
  selectDue,
  stripTerminalControls,
  takeRun,
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
  it("refuses a query or a fragment", () => {
    assert.match(resolveApi({ BREAKDOWN_API: "https://x.tail1.ts.net/?a=1" }).error, /query or fragment/);
    assert.match(resolveApi({ BREAKDOWN_API: "https://x.tail1.ts.net/?" }).error, /query or fragment/);
    assert.match(resolveApi({ BREAKDOWN_API: "https://x.tail1.ts.net#frag" }).error, /query or fragment/);
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
    assert.match(warned, /no built-in tools except Skill and ToolSearch/);
    assert.doesNotMatch(warned, /no shell or file edits/);
    assert.doesNotMatch(warned, /BREAKDOWN_TOKEN/);
    assert.match(remoteWarning("https://x.tail1.ts.net", "/repo", "24h", { hasToken: false }), /BREAKDOWN_TOKEN/);
  });
});

describe("parseWatchArgs", () => {
  it("has defaults", () => {
    assert.deepEqual(parseWatchArgs([]), { intervalMs: 30_000, once: false, dryRun: false, allowRemote: false, maxAgeMs: DAY, maxAge: "24h", maxRunsPerHour: 12 });
  });
  it("reads the flags", () => {
    const parsed = parseWatchArgs(["--interval", "60", "--once", "--dry-run", "--allow-remote", "--max-age", "2h", "--max-runs-per-hour", "3"]);
    assert.deepEqual(parsed, { intervalMs: 60_000, once: true, dryRun: true, allowRemote: true, maxAgeMs: 7_200_000, maxAge: "2h", maxRunsPerHour: 3 });
  });
  it("refuses a bad --interval", () => {
    for (const value of ["5", "abc", "1.5", "", "-30"]) assert.match(parseWatchArgs([`--interval=${value}`]).error, /--interval/, value);
  });
  it("refuses a bad --max-runs-per-hour", () => {
    for (const value of ["0", "abc", "1.5", "", "-1", "10000"]) assert.match(parseWatchArgs([`--max-runs-per-hour=${value}`]).error, /--max-runs-per-hour/, value);
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
  const opts = (tried = new Set()) => ({ status: "accepted", now, maxAgeMs: DAY, maxAge: "24h", tried });

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
    assert.equal(stale[0].reason, "decided 2026-11-13T11:59:00.000Z, older than --max-age 24h");
  });
  it("judges age by the decision, not updatedAt", () => {
    const old = item({ updatedAt: at(0), feedback: [{ decision: "accept", at: at(2 * DAY) }] });
    assert.equal(selectDue([old], opts()).stale.length, 1);
  });
  it("counts a decision up to five minutes ahead as fresh", () => {
    const skewed = item({ updatedAt: new Date(now + 5 * 60_000).toISOString() });
    assert.deepEqual(selectDue([skewed], opts()).due, [skewed]);
  });
  it("skips a decision more than five minutes ahead as unreadable", () => {
    const future = item({ updatedAt: new Date(now + 5 * 60_000 + 1000).toISOString() });
    const far = item({ id: ID_B, feedback: [{ decision: "accept", at: new Date(now + HOUR).toISOString() }] });
    const { due, stale } = selectDue([future, far], opts());
    assert.deepEqual(due, []);
    assert.deepEqual(stale.map((s) => s.item), [future, far]);
    assert.match(stale[0].reason, /is in the future/);
  });
  it("requires the --max-age label", () => {
    assert.throws(() => selectDue([], { status: "accepted", now, maxAgeMs: DAY, tried: new Set() }), /maxAge/);
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

describe("planTick", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const fresh = (n, status = "accepted") => item({ id: uuid(n), status, updatedAt: new Date(now - 60_000).toISOString() });
  const opts = (tried) => ({ tried, now, maxAgeMs: DAY, maxAge: "24h" });

  it("caps a batch at MAX_IDS_PER_RUN, runs the leftovers next tick, and logs a stale item once", () => {
    const items = [...Array.from({ length: 30 }, (_, i) => fresh(i)), item({ id: uuid(99), updatedAt: new Date(now - 2 * DAY).toISOString() })];
    const start = new Set();
    const first = planTick(items, opts(start));
    assert.equal(start.size, 0, "the argument is not changed");
    assert.deepEqual(first.batches.map((b) => [b.status, b.ids.length]), [["accepted", MAX_IDS_PER_RUN]]);
    assert.deepEqual(first.batches[0].ids, items.slice(0, 25).map((i) => i.id));
    assert.deepEqual(first.leftover, { accepted: 5, changes: 0 });
    assert.deepEqual(first.stale.map((s) => [s.item.id, s.status]), [[uuid(99), "accepted"]]);

    const second = planTick(items, opts(first.tried));
    assert.deepEqual(second.batches.map((b) => b.ids), [items.slice(25, 30).map((i) => i.id)]);
    assert.deepEqual(second.leftover, { accepted: 0, changes: 0 });
    assert.deepEqual(second.stale, []);

    const third = planTick(items, opts(second.tried));
    assert.deepEqual(third.batches, []);
    assert.deepEqual(third.stale, []);
  });
  it("plans one batch per status", () => {
    const plan = planTick([fresh(1), fresh(2, "changes")], opts(new Set()));
    assert.deepEqual(plan.batches, [
      { status: "accepted", ids: [uuid(1)] },
      { status: "changes", ids: [uuid(2)] },
    ]);
  });
  it("prunes tried keys whose id the poll no longer reports", () => {
    const plan = planTick([fresh(1)], opts(new Set([`${uuid(1)}@old`, `${uuid(2)}@gone`])));
    assert.deepEqual([...plan.tried].sort(), [`${uuid(1)}@${fresh(1).updatedAt}`, `${uuid(1)}@old`]);
  });
  it("runs an item again once its version changes", () => {
    const first = planTick([fresh(1)], opts(new Set()));
    const bumped = item({ id: uuid(1), updatedAt: new Date(now - 30_000).toISOString() });
    assert.deepEqual(planTick([bumped], opts(first.tried)).batches, [{ status: "accepted", ids: [uuid(1)] }]);
  });
});

describe("takeRun", () => {
  it("allows up to the budget in an hour, then refuses", () => {
    let starts = [];
    for (let i = 0; i < 12; i += 1) {
      const taken = takeRun(starts, 1_000_000 + i * 1000, 12);
      assert.equal(taken.allowed, true);
      starts = taken.starts;
    }
    const refused = takeRun(starts, 1_000_000 + 60_000, 12);
    assert.equal(refused.allowed, false);
    assert.equal(refused.starts.length, 12);
  });
  it("forgets runs older than an hour", () => {
    const taken = takeRun([0, 1000], HOUR + 500, 2);
    assert.deepEqual(taken, { allowed: true, starts: [1000, HOUR + 500] });
  });
  it("does not change its argument", () => {
    const starts = [5];
    takeRun(starts, 10, 3);
    assert.deepEqual(starts, [5]);
  });
});

describe("readBodyCapped", () => {
  it("reads a body within the cap", async () => {
    assert.equal(await readBodyCapped(new Response("héllo"), 100), "héllo");
  });
  it("refuses a declared length past the cap", async () => {
    await assert.rejects(readBodyCapped(new Response("x".repeat(50), { headers: { "content-length": "50" } }), 10), /more than 10/);
  });
  it("refuses a streamed body past the cap", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
    });
    await assert.rejects(readBodyCapped(new Response(stream), 20), /more than 20/);
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
  it("allows only Skill and ToolSearch of the built-in tools, after the prompt and before another flag", () => {
    const args = claudeArgs("P");
    assert.equal(RUN_TOOLS, "Skill,ToolSearch");
    assert.deepEqual(args, ["-p", "P", "--mcp-config", ".mcp.json", "--tools", "Skill,ToolSearch", "--permission-mode", "bypassPermissions"]);
    assert.equal(args[1], "P");
    assert.equal(args.indexOf("--tools") + 2, args.indexOf("--permission-mode"));
    assert.ok(!args.includes("--disallowedTools"));
  });
});

describe("sanitizeForLog", () => {
  it("strips control characters", () => {
    const clean = sanitizeForLog("\u001b[31mbad\nline\r\u0007");
    assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f]/);
    assert.match(clean, /bad line/);
  });
  it("strips bidi overrides and line separators", () => {
    const clean = sanitizeForLog("a\u202eb\u2066c\u2069d\u2028e\u2029f\u202ag");
    assert.doesNotMatch(clean, /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    assert.equal(clean, "a b c d e f g");
  });
  it("truncates", () => {
    assert.equal(sanitizeForLog("x".repeat(500)).length, 301);
    assert.equal(sanitizeForLog("abcdef", 3), "abc…");
  });
});

describe("stripTerminalControls", () => {
  it("removes escape, OSC, and C1 controls, keeping newlines and tabs", () => {
    const out = stripTerminalControls("\u001b[31mred\u001b[0m\tok\n\u001b]0;title\u0007done\r\u009b2J\n");
    assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    assert.equal(out, "[31mred[0m\tok\n]0;titledone2J\n");
  });
});
