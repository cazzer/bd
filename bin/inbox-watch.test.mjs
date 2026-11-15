import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "inbox-watch");
// Preloaded into the script: any fetch is reported on stderr and fails, so a
// test can tell whether the script reached the network at all.
const FETCH_PROBE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async (url) => { process.stderr.write("FETCHED " + url + "\\n"); throw new Error("fetch blocked by test"); };')}`;

function run(args, env) {
  const { BREAKDOWN_API, BREAKDOWN_TOKEN, ...rest } = process.env;
  return spawnSync(process.execPath, ["--import", FETCH_PROBE, SCRIPT, ...args], { env: { ...rest, ...env }, encoding: "utf8", timeout: 20_000 });
}

describe("bin/inbox-watch", () => {
  it("refuses a non-loopback BREAKDOWN_API before fetching anything", () => {
    const result = run(["--once"], { BREAKDOWN_API: "https://example.com" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BREAKDOWN_API example\.com is not loopback/);
    assert.match(result.stderr, /--allow-remote/);
    assert.doesNotMatch(result.stderr, /FETCHED/);
    assert.equal(result.stdout, "");
  });
  it("refuses a bad flag before fetching anything", () => {
    const result = run(["--interval", "abc"], { BREAKDOWN_API: "http://127.0.0.1:1" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--interval/);
    assert.doesNotMatch(result.stderr, /FETCHED/);
  });
  it("polls a loopback BREAKDOWN_API (the probe sees the fetch)", () => {
    const result = run(["--once", "--dry-run"], { BREAKDOWN_API: "http://127.0.0.1:1" });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /FETCHED http:\/\/127\.0\.0\.1:1\/trpc\/inbox/);
    assert.match(result.stdout, /can't read the inbox \(fetch blocked by test\)/);
  });
});
