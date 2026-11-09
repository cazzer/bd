import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_PORT,
  LABEL,
  USAGE,
  entryPath,
  parseArgs,
  readPlist,
  renderPlist,
  runService,
  serviceDetails,
  servicePaths,
  xmlEscape,
} from "./mcp-service-lib.mjs";

const UID = 501;
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const TARGET = `gui/${UID}/${LABEL}`;
// install and status check the plist's node and entrypoint exist, so these are real paths.
const NODE = process.execPath;
let REPO;

const tempDirs = [];
async function tempDir(prefix = "mcp-service-test-") {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
async function fakeRepo() {
  const repo = await tempDir("mcp-service-repo-");
  await fs.mkdir(path.dirname(entryPath(repo)), { recursive: true });
  await fs.writeFile(entryPath(repo), "");
  return repo;
}
before(async () => {
  REPO = await fakeRepo();
});
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function printOutput({ state, pid, lastExit }) {
  return [
    `${TARGET} = {`,
    "\tactive count = 1",
    `\tpath = /Users/me/Library/LaunchAgents/${LABEL}.plist`,
    "\ttype = LaunchAgent",
    `\tstate = ${state}`,
    "",
    `\tprogram = ${NODE}`,
    pid ? `\tpid = ${pid}` : null,
    `\tlast exit code = ${lastExit}`,
    "}",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
const RUNNING = { state: "running", pid: "4242", lastExit: "(never exited)" };
const CRASH_LOOP = { state: "spawn scheduled", pid: null, lastExit: "1" };

/** `ps -o lstart=` in the C locale: "Mon Nov  9 00:37:38 2026", local time. */
function lstart(date) {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${day} ${month} ${String(date.getDate()).padStart(2, " ")} ${time} ${date.getFullYear()}    \n`;
}

/**
 * A stand-in for launchctl, git, and ps. launchd state is one boolean plus
 * the print fields of the loaded job; every call is logged as "<cmd> <verb>".
 * After a successful bootout, `print` still reports the job loaded for
 * `stillLoadedPolls` calls. `bootoutResult` replaces bootout's answer.
 */
function fakeSystem({
  loaded = false,
  job = RUNNING,
  head = HEAD,
  behind = 0,
  health = [{ status: 200, body: '{"ready":true}' }],
  stillLoadedPolls = 0,
  bootoutResult = null,
  startedAt = new Date(Date.now() - 3_600_000),
} = {}) {
  const state = { loaded, calls: [], fetches: [], lingering: 0 };
  const run = async (cmd, args) => {
    state.calls.push(`${cmd} ${args[0]}`);
    if (cmd === "launchctl") {
      const [verb] = args;
      if (verb === "bootout") {
        if (bootoutResult) return bootoutResult;
        if (!state.loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };
        state.loaded = false;
        state.lingering = stillLoadedPolls;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "bootstrap") {
        if (state.loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
        state.loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "print") {
        if (state.lingering > 0) {
          state.lingering--;
          return { code: 0, stdout: printOutput(RUNNING), stderr: "" };
        }
        return state.loaded
          ? { code: 0, stdout: printOutput(job), stderr: "" }
          : { code: 113, stdout: "", stderr: `Bad request.\nCould not find service "${LABEL}" in domain for user gui: ${UID}\n` };
      }
    }
    if (cmd === "git" && args[0] === "rev-parse") return head ? { code: 0, stdout: `${head}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "fatal" };
    if (cmd === "git" && args[0] === "rev-list") {
      assert.equal(args[2], "--end-of-options");
      return { code: 0, stdout: `${behind}\n`, stderr: "" };
    }
    if (cmd === "ps") return startedAt ? { code: 0, stdout: lstart(startedAt), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
  };
  let attempt = 0;
  const fetch = async (url) => {
    state.fetches.push(url);
    const next = health[Math.min(attempt++, health.length - 1)];
    if (next === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return { status: next.status, text: async () => next.body };
  };
  return { state, run, fetch };
}

async function service(home, sys, argv, overrides = {}) {
  const out = [];
  const warn = [];
  let clock = 1_000_000;
  const { exitCode } = await runService({
    argv,
    platform: "darwin",
    homedir: home,
    uid: UID,
    execPath: NODE,
    repoRoot: REPO,
    run: sys.run,
    fetch: sys.fetch,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    out: (line) => out.push(line),
    warn: (line) => warn.push(line),
    ...overrides,
  });
  return { exitCode, out: out.join("\n"), warn: warn.join("\n") };
}

const exists = (file) => fs.access(file).then(() => true, () => false);
const launchd = (calls) => calls.filter((c) => c === "launchctl bootout" || c === "launchctl bootstrap");

describe("parseArgs", () => {
  it("accepts each subcommand", () => {
    for (const command of ["install", "restart", "uninstall", "status"]) {
      assert.deepEqual(parseArgs([command]), { command, port: null });
    }
  });
  it("passes --port through for install and restart", () => {
    assert.deepEqual(parseArgs(["install", "--port", "5321"]), { command: "install", port: 5321 });
    assert.deepEqual(parseArgs(["restart", "--port=65535"]), { command: "restart", port: 65535 });
  });
  it("refuses an invalid --port", () => {
    for (const bad of ["0", "65536", "-1", "1.5", "abc", "", "5320x", "999999"]) {
      assert.match(parseArgs(["install", `--port=${bad}`]).error, /--port must be an integer from 1 to 65535/, bad);
    }
  });
  it("refuses --port where it does not apply", () => {
    assert.match(parseArgs(["status", "--port", "5321"]).error, /only to install and restart/);
  });
  it("refuses unknown, missing, and extra subcommands", () => {
    assert.match(parseArgs(["start"]).error, /unknown subcommand: start/);
    assert.match(parseArgs([]).error, /missing subcommand/);
    assert.match(parseArgs(["install", "now"]).error, /unexpected argument: now/);
    assert.match(parseArgs(["install", "--verbose"]).error, /Unknown option/);
  });
});

describe("renderPlist", () => {
  const node = "/Users/me/.nvm/versions/node/v22.23.1/bin/node";
  const repo = "/Users/me/dev/bd";
  const paths = servicePaths("/Users/me");
  const xml = renderPlist({ execPath: node, repoRoot: repo, port: 5320, paths });

  it("runs one node process with tsx as a loader and the HTTP entrypoint", () => {
    assert.match(
      xml,
      new RegExp(
        [
          "<key>ProgramArguments</key>",
          "<array>",
          `<string>${node}</string>`,
          "<string>--import</string>",
          "<string>tsx</string>",
          `<string>${repo}/apps/mcp/src/http.ts</string>`,
          "<string>--port</string>",
          "<string>5320</string>",
          "</array>",
        ].join("\\s*"),
      ),
    );
  });
  it("sets the label, working directory, supervision keys, and log paths", () => {
    const keyed = (key, value) => assert.match(xml, new RegExp(`<key>${key}</key>\\s*${value}`), key);
    keyed("Label", `<string>${LABEL}</string>`);
    keyed("WorkingDirectory", `<string>${repo}/apps/mcp</string>`);
    keyed("RunAtLoad", "<true/>");
    keyed("KeepAlive", "<true/>");
    keyed("ThrottleInterval", "<integer>10</integer>");
    keyed("ExitTimeOut", "<integer>15</integer>");
    keyed("StandardErrorPath", "<string>/Users/me/Library/Logs/breakdown/brain.err.log</string>");
    keyed("StandardOutPath", "<string>/Users/me/Library/Logs/breakdown/brain.out.log</string>");
  });
  it("carries no environment", () => {
    assert.doesNotMatch(xml, /EnvironmentVariables|DATABASE_URL/);
  });
  it("XML-escapes every interpolated value", () => {
    const odd = renderPlist({ execPath: "/opt/n&de/<bin>/node", repoRoot: "/Users/me/R&D 'x' \"y\"", port: 5320, paths: servicePaths("/Users/a&b") });
    assert.match(odd, /<string>\/opt\/n&amp;de\/&lt;bin&gt;\/node<\/string>/);
    assert.match(odd, /<string>\/Users\/me\/R&amp;D &apos;x&apos; &quot;y&quot;\/apps\/mcp<\/string>/);
    assert.match(odd, /<string>\/Users\/a&amp;b\/Library\/Logs\/breakdown\/brain.err.log<\/string>/);
    assert.doesNotMatch(odd, /&(?!amp;|lt;|gt;|quot;|apos;)/);
    assert.equal(xmlEscape(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
    assert.deepEqual(readPlist(odd), { node: "/opt/n&de/<bin>/node", entry: "/Users/me/R&D 'x' \"y\"/apps/mcp/src/http.ts", port: 5320, badPort: null });
  });
  it("reads its own node, entrypoint, and port back", () => {
    assert.deepEqual(readPlist(xml), { node, entry: `${repo}/apps/mcp/src/http.ts`, port: 5320, badPort: null });
    assert.equal(readPlist(renderPlist({ execPath: node, repoRoot: repo, port: 6001, paths })).port, 6001);
    assert.deepEqual(readPlist("<plist/>"), { node: null, entry: null, port: null, badPort: null });
  });
  it("reads an out-of-range port as absent, and reports it", () => {
    for (const bad of ["0", "70000"]) {
      const edited = xml.replace("<string>5320</string>", `<string>${bad}</string>`);
      assert.deepEqual(readPlist(edited), { node, entry: `${repo}/apps/mcp/src/http.ts`, port: null, badPort: bad });
    }
  });
  it("is a well-formed property list (plutil)", { skip: process.platform !== "darwin" }, async () => {
    const file = path.join(await tempDir(), "test.plist");
    await fs.writeFile(file, renderPlist({ execPath: node, repoRoot: "/tmp/R&D <x>", port: 5320, paths }));
    const result = await new Promise((resolve) => execFile("plutil", ["-lint", file], (err, stdout) => resolve({ err, stdout })));
    assert.equal(result.err, null, result.stdout);
  });
});

describe("serviceDetails", () => {
  it("keeps the state, pid, and last exit code lines", () => {
    assert.equal(serviceDetails(printOutput(RUNNING)), "state = running, pid = 4242, last exit code = (never exited)");
    assert.equal(serviceDetails(printOutput(CRASH_LOOP)), "state = spawn scheduled, last exit code = 1");
  });
});

describe("install", () => {
  it("writes the plist, logs dir, and installed commit, bootstraps, and reports health, pid, and the node path", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    const result = await service(home, sys, ["install"]);
    const paths = servicePaths(home);
    assert.equal(result.exitCode, 0, result.warn);
    assert.equal(readPlist(await fs.readFile(paths.plist, "utf8")).port, DEFAULT_PORT);
    assert.equal((await fs.stat(paths.logsDir)).mode & 0o777, 0o700);
    assert.equal(await exists(`${paths.plist}.tmp`), false);
    assert.equal(await fs.readFile(paths.commitFile, "utf8"), `${HEAD}\n`);
    assert.deepEqual(launchd(sys.state.calls), ["launchctl bootout", "launchctl bootstrap"]);
    assert.ok(sys.state.loaded);
    assert.match(result.out, new RegExp(`node\\s+${escapeRegExp(NODE)}`));
    assert.match(result.out, /health\s+200 \{"ready":true\}/);
    assert.match(result.out, /pid\s+4242/);
    assert.equal(sys.state.fetches[0], `http://127.0.0.1:${DEFAULT_PORT}/healthz`);
  });

  it("twice leaves one plist, with bootout then bootstrap each time", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    assert.equal((await service(home, sys, ["install"])).exitCode, 0);
    const second = await service(home, sys, ["install"]);
    assert.equal(second.exitCode, 0, second.warn);
    assert.match(second.out, /^reloaded/);
    assert.deepEqual(launchd(sys.state.calls), ["launchctl bootout", "launchctl bootstrap", "launchctl bootout", "launchctl bootstrap"]);
    assert.deepEqual(await fs.readdir(path.join(home, "Library", "LaunchAgents")), [`${LABEL}.plist`]);
    assert.doesNotMatch(second.out, / was /);
  });

  it("passes --port through to ProgramArguments, the health probe, and status", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    assert.equal((await service(home, sys, ["install", "--port", "6123"])).exitCode, 0);
    const xml = await fs.readFile(servicePaths(home).plist, "utf8");
    assert.match(xml, /<string>--port<\/string>\s*<string>6123<\/string>/);
    assert.equal(sys.state.fetches[0], "http://127.0.0.1:6123/healthz");
    const status = await service(home, sys, ["status"]);
    assert.match(status.out, /^port\s+6123$/m);
    assert.equal(sys.state.fetches.at(-1), "http://127.0.0.1:6123/healthz");
  });

  it("restart without --port keeps the installed port", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    await service(home, sys, ["install", "--port", "6123"]);
    assert.equal((await service(home, sys, ["restart"])).exitCode, 0);
    assert.equal(readPlist(await fs.readFile(servicePaths(home).plist, "utf8")).port, 6123);
  });

  it("an installed port outside 1–65535 is ignored with a warning", async () => {
    const home = await tempDir();
    const paths = servicePaths(home);
    await fs.mkdir(path.dirname(paths.plist), { recursive: true });
    await fs.writeFile(paths.plist, renderPlist({ execPath: NODE, repoRoot: REPO, port: 5320, paths }).replace("<string>5320</string>", "<string>99999</string>"));
    const result = await service(home, fakeSystem(), ["restart"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.match(result.warn, /has --port 99999, outside 1–65535; ignoring it/);
    assert.equal(readPlist(await fs.readFile(paths.plist, "utf8")).port, DEFAULT_PORT);
  });

  it("rewrites a plist from another node and checkout, saying what changed", async () => {
    const home = await tempDir();
    const paths = servicePaths(home);
    await fs.mkdir(path.dirname(paths.plist), { recursive: true });
    await fs.writeFile(paths.plist, renderPlist({ execPath: "/old/node", repoRoot: "/old/repo", port: 6001, paths }));
    const sys = fakeSystem({ loaded: true });
    const result = await service(home, sys, ["restart"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.deepEqual(readPlist(await fs.readFile(paths.plist, "utf8")), { node: NODE, entry: entryPath(REPO), port: 6001, badPort: null });
    assert.ok(result.out.includes(`node was /old/node, now ${NODE}`), result.out);
    assert.ok(result.out.includes(`repo was /old/repo, now ${REPO}`), result.out);
  });

  it("polls /healthz until it answers 200", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ health: ["refused", "refused", { status: 503, body: "{}" }, { status: 200, body: '{"ready":true}' }] });
    assert.equal((await service(home, sys, ["install"])).exitCode, 0);
    assert.equal(sys.state.fetches.length, 4);
  });

  it("exits 1 after a 15s deadline, printing only what the error log gained since bootstrap", async () => {
    const home = await tempDir();
    const paths = servicePaths(home);
    await fs.mkdir(paths.logsDir, { recursive: true });
    await fs.writeFile(paths.errLog, "an old crash from last week\n");
    const sys = fakeSystem({ health: ["refused"] });
    const run = async (cmd, args, opts) => {
      const result = await sys.run(cmd, args, opts);
      if (cmd === "launchctl" && args[0] === "bootstrap") await fs.appendFile(paths.errLog, "[breakdown-brain] cannot start: database unreachable\n");
      return result;
    };
    const result = await service(home, sys, ["install"], { run });
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /not healthy after 15s: no answer on 127\.0\.0\.1:5320 \(ECONNREFUSED\)/);
    assert.match(result.warn, /cannot start: database unreachable/);
    assert.doesNotMatch(result.warn, /old crash/);
    assert.equal(sys.state.fetches.length, 31, "one probe at the start, then one per 500ms until 15s");
    assert.ok(await exists(paths.plist), "the service stays installed for launchd to retry");
    assert.equal(await fs.readFile(paths.commitFile, "utf8"), `${HEAD}\n`);
  });

  it("is not healthy when another process answers 200 while the job crash-loops", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ job: CRASH_LOOP });
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /answered 200 \{"ready":true\}, but dev\.breakdown\.brain is not running \(state = spawn scheduled, last exit code = 1\)/);
    assert.match(result.warn, /some other process is answering on that port/);
    assert.doesNotMatch(result.out, /health\s+200/);
  });

  it("refuses when bootstrap fails", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    const run = async (cmd, args, opts) =>
      cmd === "launchctl" && args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : sys.run(cmd, args, opts);
    const result = await service(home, sys, ["install"], { run });
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /launchctl bootstrap gui\/501 .* failed \(exit 5\): Bootstrap failed/);
  });
});

describe("bootout", () => {
  it("waits until launchd has let the old job go before bootstrapping", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ loaded: true, stillLoadedPolls: 5 });
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 0, result.warn);
    const calls = sys.state.calls.filter((c) => c.startsWith("launchctl "));
    const polls = calls.slice(calls.indexOf("launchctl bootout") + 1, calls.indexOf("launchctl bootstrap"));
    assert.deepEqual(polls, Array(6).fill("launchctl print"), "five still loaded, then gone");
  });

  it("refuses when the job is still loaded after 20s", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ loaded: true, stillLoadedPolls: Infinity });
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /gui\/501\/dev\.breakdown\.brain was still loaded 20s after bootout/);
    assert.equal(launchd(sys.state.calls).includes("launchctl bootstrap"), false);
  });

  it("refuses an unexpected bootout failure, naming it", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ bootoutResult: { code: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error\n" } });
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /launchctl bootout gui\/501\/dev\.breakdown\.brain failed \(exit 5\): Boot-out failed: 5: Input\/output error/);
    assert.equal(await exists(servicePaths(home).plist), false);
  });

  it('treats 113 "Could not find specified service" as not loaded', async () => {
    const home = await tempDir();
    const sys = fakeSystem({ bootoutResult: { code: 113, stdout: "", stderr: "Boot-out failed: 113: Could not find specified service\n" } });
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.match(result.out, /^loaded dev\.breakdown\.brain/);
  });

  it('refuses 112 "Could not find domain"', async () => {
    const home = await tempDir();
    const sys = fakeSystem({ bootoutResult: { code: 112, stdout: "", stderr: "Boot-out failed: 112: Could not find domain\n" } });
    const result = await service(home, sys, ["uninstall"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /failed \(exit 112\): Boot-out failed: 112: Could not find domain/);
  });
});

describe("uninstall", () => {
  it("unloads, removes the plist and the commit file, and leaves the logs", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    const paths = servicePaths(home);
    await service(home, sys, ["install"]);
    await fs.writeFile(paths.errLog, "old log\n");
    await fs.writeFile(paths.outLog, "");
    const result = await service(home, sys, ["uninstall"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.equal(sys.state.loaded, false);
    assert.equal(await exists(paths.plist), false);
    assert.equal(await exists(paths.commitFile), false);
    assert.equal(await fs.readFile(paths.errLog, "utf8"), "old log\n");
    assert.ok(await exists(paths.outLog));
    assert.match(result.out, /stopped and unloaded/);
  });

  it("succeeds when nothing is installed", async () => {
    const home = await tempDir();
    const result = await service(home, fakeSystem(), ["uninstall"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.match(result.out, /was not loaded/);
  });
});

describe("status", () => {
  it("not loaded: exit 1", async () => {
    const home = await tempDir();
    const result = await service(home, fakeSystem({ health: ["refused"] }), ["status"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.out, /^service\s+dev\.breakdown\.brain: not loaded$/m);
    assert.match(result.out, /^plist\s+not installed/m);
    assert.match(result.out, /^port\s+5320 \(default\)$/m);
    assert.match(result.out, /^health\s+no answer on 127\.0\.0\.1:5320/m);
  });

  it("loaded and healthy: exit 0, with pid, state, node, entry, health, commit, and log paths", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    await service(home, sys, ["install"]);
    const result = await service(home, sys, ["status"]);
    const paths = servicePaths(home);
    assert.equal(result.exitCode, 0, result.out + result.warn);
    assert.equal(result.warn, "");
    assert.match(result.out, /^service\s+dev\.breakdown\.brain: loaded \(state = running, pid = 4242/m);
    assert.ok(result.out.includes(`node     ${NODE}`) && result.out.includes(`entry    ${entryPath(REPO)}`), result.out);
    assert.match(result.out, /^health\s+200 \{"ready":true\}$/m);
    assert.match(result.out, /^commit\s+installed a{12} = HEAD$/m);
    assert.ok(result.out.includes(paths.errLog) && result.out.includes(paths.outLog));
  });

  it("loaded but /healthz 503: exit 1 with the reason", async () => {
    const home = await tempDir();
    const sys = fakeSystem({ health: [{ status: 200, body: "{}" }, { status: 503, body: '{"ready":false,"error":"connect ECONNREFUSED"}' }] });
    await service(home, sys, ["install"]);
    const result = await service(home, sys, ["status"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.out, /^health\s+503 \{"ready":false,"error":"connect ECONNREFUSED"\}$/m);
  });

  it("200 from another process while the job crash-loops: exit 1 with the last exit code", async () => {
    const home = await tempDir();
    await service(home, fakeSystem(), ["install"]);
    const result = await service(home, fakeSystem({ loaded: true, job: CRASH_LOOP }), ["status"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /answered 200, but dev\.breakdown\.brain is not running \(state = spawn scheduled, last exit code = 1\)/);
  });

  it("commit behind: says how many commits a restart picks up, still exit 0", async () => {
    const home = await tempDir();
    await service(home, fakeSystem({ head: OLD }), ["install"]);
    const result = await service(home, fakeSystem({ loaded: true, head: HEAD, behind: 3 }), ["status"]);
    assert.equal(result.exitCode, 0, result.out);
    assert.match(result.out, /^commit\s+installed b{12}, HEAD a{12}: restart to pick up 3 newer commits \(pnpm mcp:service restart\)$/m);
  });

  it("restarted by launchd after install: names the restart time instead of a commit count", async () => {
    const home = await tempDir();
    await service(home, fakeSystem({ head: OLD }), ["install"]);
    const startedAt = new Date(Date.now() + 120_000);
    const sys = fakeSystem({ loaded: true, head: HEAD, behind: 3, startedAt });
    const result = await service(home, sys, ["status"]);
    assert.equal(result.exitCode, 0, result.out);
    const when = lstart(startedAt).trim().replace(/\s+/g, " ");
    assert.ok(result.out.includes(`launchd restarted it at ${when}; running code is the working tree as of then`), result.out);
    assert.doesNotMatch(result.out, /newer commits/);
    assert.equal(sys.state.calls.includes("git rev-list"), false);
  });

  it("an unreadable commit file is reported, not passed to git", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    await service(home, sys, ["install"]);
    await fs.writeFile(servicePaths(home).commitFile, "--output=/tmp/x\n");
    const result = await service(home, sys, ["status"]);
    assert.match(result.out, /^commit\s+installed unknown \(.*brain\.installed-commit is not a commit id\), HEAD a{12}$/m);
    assert.equal(sys.state.calls.includes("git rev-list"), false);
  });

  it("warns when the plist's node or entrypoint is missing or not this checkout's", async () => {
    const home = await tempDir();
    const paths = servicePaths(home);
    await fs.mkdir(path.dirname(paths.plist), { recursive: true });
    const otherRepo = await fakeRepo();
    await fs.writeFile(paths.plist, renderPlist({ execPath: "/gone/node", repoRoot: otherRepo, port: 5320, paths }));
    const result = await service(home, fakeSystem({ loaded: true }), ["status"]);
    assert.match(result.out, /^node\s+\/gone\/node$/m);
    assert.match(result.warn, /the plist's node \/gone\/node no longer exists; run `pnpm mcp:service restart`/);
    assert.ok(result.warn.includes(`the plist's entrypoint is ${entryPath(otherRepo)}, but this checkout's is ${entryPath(REPO)}; run \`pnpm mcp:service restart\``), result.warn);
  });
});

describe("runService", () => {
  it("refuses off macOS, pointing at the portable server command", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    const result = await service(home, sys, ["install"], { platform: "linux" });
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /macOS-only.*this is linux/);
    assert.match(result.warn, /pnpm mcp:serve --port <n>/);
    assert.deepEqual(sys.state.calls, []);
    assert.equal(await exists(path.join(home, "Library")), false);
  });

  it("prints usage and exits 2 for an unknown subcommand", async () => {
    const home = await tempDir();
    const sys = fakeSystem();
    const result = await service(home, sys, ["start"]);
    assert.equal(result.exitCode, 2);
    assert.ok(result.warn.includes(USAGE));
    assert.deepEqual(sys.state.calls, []);
  });

  it("prints usage and exits 0 for --help", async () => {
    const result = await service(await tempDir(), fakeSystem(), ["--help"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.out, USAGE);
  });
});
