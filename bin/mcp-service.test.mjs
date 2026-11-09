import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  DEFAULT_PORT,
  LABEL,
  USAGE,
  parseArgs,
  plistPort,
  renderPlist,
  runService,
  serviceDetails,
  servicePaths,
  xmlEscape,
} from "./mcp-service-lib.mjs";

const UID = 501;
const NODE = "/Users/me/.nvm/versions/node/v22.23.1/bin/node";
const REPO = "/Users/me/dev/bd";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const TARGET = `gui/${UID}/${LABEL}`;

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function tempHome() {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-service-test-")));
  tempDirs.push(dir);
  return dir;
}

const PRINT_LOADED = `${TARGET} = {
\tactive count = 1
\tpath = /Users/me/Library/LaunchAgents/${LABEL}.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = ${NODE}
\tpid = 4242
\tlast exit code = (never exited)
}
`;

/**
 * A stand-in for launchctl and git. launchd state is one boolean; every call
 * is logged as "launchctl <verb>" or "git <verb>".
 */
function fakeSystem({ loaded = false, head = HEAD, behind = 0, health = [{ status: 200, body: '{"ready":true}' }] } = {}) {
  const state = { loaded, calls: [], fetches: [] };
  const run = async (cmd, args) => {
    state.calls.push(`${cmd} ${args[0]}`);
    if (cmd === "launchctl") {
      const [verb] = args;
      if (verb === "bootout") {
        if (!state.loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };
        state.loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "bootstrap") {
        if (state.loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
        state.loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "print") {
        return state.loaded
          ? { code: 0, stdout: PRINT_LOADED, stderr: "" }
          : { code: 113, stdout: "", stderr: `Bad request.\nCould not find service "${LABEL}" in domain for user gui: ${UID}\n` };
      }
    }
    if (cmd === "git" && args[0] === "rev-parse") return head ? { code: 0, stdout: `${head}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "fatal" };
    if (cmd === "git" && args[0] === "rev-list") return { code: 0, stdout: `${behind}\n`, stderr: "" };
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

function deps(home, sys, argv, overrides = {}) {
  const out = [];
  const warn = [];
  return {
    out,
    warn,
    deps: {
      argv,
      platform: "darwin",
      homedir: home,
      uid: UID,
      execPath: NODE,
      repoRoot: REPO,
      run: sys.run,
      fetch: sys.fetch,
      sleep: async () => {},
      out: (line) => out.push(line),
      warn: (line) => warn.push(line),
      ...overrides,
    },
  };
}

async function service(home, sys, argv, overrides) {
  const d = deps(home, sys, argv, overrides);
  const { exitCode } = await runService(d.deps);
  return { exitCode, out: d.out.join("\n"), warn: d.warn.join("\n") };
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
  const paths = servicePaths("/Users/me");
  const xml = renderPlist({ execPath: NODE, repoRoot: REPO, port: 5320, paths });

  it("runs one node process with tsx as a loader and the HTTP entrypoint", () => {
    assert.match(
      xml,
      new RegExp(
        [
          "<key>ProgramArguments</key>",
          "<array>",
          `<string>${NODE}</string>`,
          "<string>--import</string>",
          "<string>tsx</string>",
          `<string>${REPO}/apps/mcp/src/http.ts</string>`,
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
    keyed("WorkingDirectory", `<string>${REPO}/apps/mcp</string>`);
    keyed("RunAtLoad", "<true/>");
    keyed("KeepAlive", "<true/>");
    keyed("ThrottleInterval", "<integer>10</integer>");
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
  });
  it("reads its own port back", () => {
    assert.equal(plistPort(xml), 5320);
    assert.equal(plistPort(renderPlist({ execPath: NODE, repoRoot: REPO, port: 6001, paths })), 6001);
    assert.equal(plistPort("<plist/>"), null);
  });
  it("is a well-formed property list (plutil)", { skip: process.platform !== "darwin" }, async () => {
    const dir = await tempHome();
    const file = path.join(dir, "test.plist");
    await fs.writeFile(file, renderPlist({ execPath: NODE, repoRoot: "/tmp/R&D <x>", port: 5320, paths }));
    const result = await new Promise((resolve) => execFile("plutil", ["-lint", file], (err, stdout) => resolve({ err, stdout })));
    assert.equal(result.err, null, result.stdout);
  });
});

describe("serviceDetails", () => {
  it("keeps the state, pid, and last exit code lines", () => {
    assert.equal(serviceDetails(PRINT_LOADED), "state = running, pid = 4242, last exit code = (never exited)");
  });
});

describe("install", () => {
  it("writes the plist, logs dir, and installed commit, bootstraps, and reports health and the node path", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    const result = await service(home, sys, ["install"]);
    const paths = servicePaths(home);
    assert.equal(result.exitCode, 0, result.warn);
    assert.equal(plistPort(await fs.readFile(paths.plist, "utf8")), DEFAULT_PORT);
    assert.ok(await exists(paths.logsDir));
    assert.equal(await fs.readFile(paths.commitFile, "utf8"), `${HEAD}\n`);
    assert.deepEqual(launchd(sys.state.calls), ["launchctl bootout", "launchctl bootstrap"]);
    assert.ok(sys.state.loaded);
    assert.match(result.out, new RegExp(`node\\s+${NODE}`));
    assert.match(result.out, /health\s+200 \{"ready":true\}/);
    assert.equal(sys.state.fetches[0], `http://127.0.0.1:${DEFAULT_PORT}/healthz`);
  });

  it("twice leaves one plist, with bootout then bootstrap each time", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    assert.equal((await service(home, sys, ["install"])).exitCode, 0);
    const second = await service(home, sys, ["install"]);
    assert.equal(second.exitCode, 0, second.warn);
    assert.match(second.out, /^reloaded/);
    assert.deepEqual(launchd(sys.state.calls), ["launchctl bootout", "launchctl bootstrap", "launchctl bootout", "launchctl bootstrap"]);
    assert.deepEqual(await fs.readdir(path.join(home, "Library", "LaunchAgents")), [`${LABEL}.plist`]);
  });

  it("passes --port through to ProgramArguments, the health probe, and status", async () => {
    const home = await tempHome();
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
    const home = await tempHome();
    const sys = fakeSystem();
    await service(home, sys, ["install", "--port", "6123"]);
    assert.equal((await service(home, sys, ["restart"])).exitCode, 0);
    assert.equal(plistPort(await fs.readFile(servicePaths(home).plist, "utf8")), 6123);
  });

  it("polls /healthz until it answers 200", async () => {
    const home = await tempHome();
    const sys = fakeSystem({ health: ["refused", "refused", { status: 503, body: "{}" }, { status: 200, body: '{"ready":true}' }] });
    assert.equal((await service(home, sys, ["install"])).exitCode, 0);
    assert.equal(sys.state.fetches.length, 4);
  });

  it("exits 1 naming the error log when the server never becomes healthy", async () => {
    const home = await tempHome();
    const sys = fakeSystem({ health: ["refused"] });
    const paths = servicePaths(home);
    await fs.mkdir(paths.logsDir, { recursive: true });
    await fs.writeFile(paths.errLog, "[breakdown-brain] cannot start: database unreachable\n");
    const result = await service(home, sys, ["install"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /not healthy after ~15s: no answer on 127\.0\.0\.1:5320 \(ECONNREFUSED\)/);
    assert.match(result.warn, /cannot start: database unreachable/);
    assert.ok(await exists(paths.plist), "the service stays installed for launchd to retry");
  });

  it("refuses when bootstrap fails", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    const run = async (cmd, args, opts) =>
      cmd === "launchctl" && args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : sys.run(cmd, args, opts);
    const result = await service(home, sys, ["install"], { run });
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /launchctl bootstrap gui\/501 .* failed \(exit 5\): Bootstrap failed/);
  });
});

describe("uninstall", () => {
  it("unloads, removes the plist and the commit file, and leaves the logs", async () => {
    const home = await tempHome();
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
    const home = await tempHome();
    const result = await service(home, fakeSystem(), ["uninstall"]);
    assert.equal(result.exitCode, 0, result.warn);
    assert.match(result.out, /was not loaded/);
  });
});

describe("status", () => {
  it("not loaded: exit 1", async () => {
    const home = await tempHome();
    const result = await service(home, fakeSystem({ health: ["refused"] }), ["status"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.out, /^service\s+dev\.breakdown\.brain: not loaded$/m);
    assert.match(result.out, /^plist\s+not installed/m);
    assert.match(result.out, /^port\s+5320 \(default\)$/m);
    assert.match(result.out, /^health\s+no answer on 127\.0\.0\.1:5320/m);
  });

  it("loaded and healthy: exit 0, with pid, state, health, commit, and log paths", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    await service(home, sys, ["install"]);
    const result = await service(home, sys, ["status"]);
    const paths = servicePaths(home);
    assert.equal(result.exitCode, 0, result.out);
    assert.match(result.out, /^service\s+dev\.breakdown\.brain: loaded \(state = running, pid = 4242/m);
    assert.match(result.out, /^health\s+200 \{"ready":true\}$/m);
    assert.match(result.out, /^commit\s+installed a{12} = HEAD$/m);
    assert.ok(result.out.includes(paths.errLog) && result.out.includes(paths.outLog));
  });

  it("loaded but /healthz 503: exit 1 with the reason", async () => {
    const home = await tempHome();
    const sys = fakeSystem({ health: [{ status: 200, body: "{}" }, { status: 503, body: '{"ready":false,"error":"connect ECONNREFUSED"}' }] });
    await service(home, sys, ["install"]);
    const result = await service(home, sys, ["status"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.out, /^health\s+503 \{"ready":false,"error":"connect ECONNREFUSED"\}$/m);
  });

  it("commit behind: says how many commits a restart picks up, still exit 0", async () => {
    const home = await tempHome();
    await service(home, fakeSystem({ head: OLD }), ["install"]);
    const sys = fakeSystem({ loaded: true, head: HEAD, behind: 3 });
    const result = await service(home, sys, ["status"]);
    assert.equal(result.exitCode, 0, result.out);
    assert.match(result.out, /^commit\s+installed b{12}, HEAD a{12}: restart to pick up 3 newer commits \(pnpm mcp:service restart\)$/m);
  });
});

describe("runService", () => {
  it("refuses off macOS, pointing at the portable server command", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    const result = await service(home, sys, ["install"], { platform: "linux" });
    assert.equal(result.exitCode, 1);
    assert.match(result.warn, /macOS-only.*this is linux/);
    assert.match(result.warn, /pnpm mcp:serve --port <n>/);
    assert.deepEqual(sys.state.calls, []);
    assert.equal(await exists(path.join(home, "Library")), false);
  });

  it("prints usage and exits 2 for an unknown subcommand", async () => {
    const home = await tempHome();
    const sys = fakeSystem();
    const result = await service(home, sys, ["start"]);
    assert.equal(result.exitCode, 2);
    assert.ok(result.warn.includes(USAGE));
    assert.deepEqual(sys.state.calls, []);
  });

  it("prints usage and exits 0 for --help", async () => {
    const result = await service(await tempHome(), fakeSystem(), ["--help"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.out, USAGE);
  });
});
