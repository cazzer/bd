// Pure tests of the relay's launchd service: the plist, its parse, and the
// install / status / uninstall flows against a temp HOME with a fake
// launchctl. Nothing here bootstraps a real service.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CHECK_IN_DEADLINE_MS, checkInState, entryPath, EXIT_TIMEOUT_S, LABEL, parseArgs, programArguments, readPlist, renderPlist, runService, servicePathEnv, servicePaths } from "./relay-service-lib.mjs";

const UID = 501;
const TARGET = `gui/${UID}/${LABEL}`;
const REPO = "/Users/me/dev/bd";
const NODE = "/Users/me/.nvm/versions/node/v22.23.1/bin/node";
const BD = "/opt/homebrew/bin/bd";
const HERDR = "/Users/me/.local/bin/herdr";

const tempDirs = [];
async function tempHome() {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "relay-service-test-")));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const P = ["--project", "bd=/Users/me/dev/bd"];

describe("parseArgs", () => {
  it("takes install's flags, with the token file and the relay's options optional, but at least one project", () => {
    assert.deepEqual(parseArgs(["install", "--url", "https://jetson.ts.net", "--name", "relay-laptop", ...P]), {
      command: "install",
      origin: "https://jetson.ts.net",
      name: "relay-laptop",
      tokenFile: null,
      projects: [{ key: "bd", path: "/Users/me/dev/bd" }],
      kinds: null,
      herdrSockets: [],
      maxAge: null,
    });
    assert.equal(parseArgs(["install", "--url", "https://j", "--name", "r", ...P, "--token-file", "/x/t"]).tokenFile, "/x/t");
    assert.deepEqual(parseArgs(["install", "--url", "https://j", "--name", "r", ...P, "--kinds", "beads_reingest", "--herdr-socket", "/s.sock", "--max-age", "6h"]), {
      command: "install",
      origin: "https://j",
      name: "r",
      tokenFile: null,
      projects: [{ key: "bd", path: "/Users/me/dev/bd" }],
      kinds: "beads_reingest",
      herdrSockets: ["/s.sock"],
      maxAge: "6h",
    });
  });

  it("refuses missing or bad install flags, and flags on other commands", () => {
    assert.deepEqual(parseArgs(["install", "--name", "r", ...P]), { error: "--url is required" });
    assert.deepEqual(parseArgs(["install", "--url", "https://j", ...P]), { error: "--name is required" });
    assert.match(parseArgs(["install", "--url", "https://j", "--name", "r"]).error, /--project <key>=<absolute path> is required/);
    assert.match(parseArgs(["install", "--url", "https://j", "--name", "r", "--project", "bd"]).error, /<key>=<absolute path>/);
    assert.match(parseArgs(["install", "--url", "http://example.com", "--name", "r", ...P]).error, /plain http/);
    assert.match(parseArgs(["install", "--url", "https://j/path", "--name", "r", ...P]).error, /origin with no path/);
    assert.match(parseArgs(["install", "--url", "https://j", "--name", "r", ...P, "--token-file", "t"]).error, /absolute/);
    assert.deepEqual(parseArgs(["status", "--url", "https://j"]), { error: "--url applies only to install" });
    assert.deepEqual(parseArgs(["status", ...P]), { error: "--project applies only to install" });
    assert.deepEqual(parseArgs(["status"]), { command: "status" });
    assert.deepEqual(parseArgs([]), { error: "missing subcommand" });
    assert.deepEqual(parseArgs(["restart"]), { error: "unknown subcommand: restart" });
  });
});

describe("the plist", () => {
  const paths = servicePaths("/Users/me");
  const projects = [{ key: "bd", path: "/Users/me/dev/bd" }, { key: "e2e", path: "/Users/me/e2e" }];
  const args = { execPath: NODE, repoRoot: REPO, origin: "https://jetson.ts.net", tokenFile: "/Users/me/.config/breakdown/relay-token", name: "relay-laptop", projects };

  it("runs node with tsx on bin/relay.mjs and the flags, from apps/web", () => {
    assert.deepEqual(programArguments(args), [
      NODE, "--import", "tsx", `${REPO}/bin/relay.mjs`,
      "--url", "https://jetson.ts.net", "--token-file", "/Users/me/.config/breakdown/relay-token", "--name", "relay-laptop",
      "--project", "bd=/Users/me/dev/bd", "--project", "e2e=/Users/me/e2e",
    ]);
    assert.deepEqual(programArguments({ ...args, projects: projects.slice(0, 1), kinds: "beads_reingest", herdrSockets: ["/a.sock", "/b.sock"], maxAge: "6h" }).slice(10), [
      "--project", "bd=/Users/me/dev/bd", "--kinds", "beads_reingest", "--herdr-socket", "/a.sock", "--herdr-socket", "/b.sock", "--max-age", "6h",
    ]);
    const xml = renderPlist({ ...args, pathEnv: servicePathEnv({ bd: BD, herdr: HERDR }), paths });
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replaceAll(".", "\\.")}</string>`));
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/dev\/bd\/apps\/web<\/string>/);
    assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/Users\/me\/\.local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    assert.match(xml, new RegExp(`<key>ExitTimeOut</key>\\s*<integer>${EXIT_TIMEOUT_S}</integer>`));
    assert.equal(EXIT_TIMEOUT_S, 200);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/breakdown\/relay\.err\.log<\/string>/);
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/Library\/Logs\/breakdown\/relay\.out\.log<\/string>/);
    assert.doesNotMatch(xml, /bdt_/);
  });

  it("reads back what it wrote, escaping included", () => {
    const odd = { ...args, tokenFile: "/Users/me/a&b <c>/token", name: "relay'laptop", kinds: "review_decision,herdr_prompt", herdrSockets: ["/s<1>.sock"], maxAge: "12h" };
    const xml = renderPlist({ ...odd, pathEnv: "/opt/a&b:/usr/bin", paths });
    assert.match(xml, /a&amp;b &lt;c&gt;/);
    assert.deepEqual(readPlist(xml), {
      node: NODE,
      entry: entryPath(REPO),
      origin: "https://jetson.ts.net",
      tokenFile: "/Users/me/a&b <c>/token",
      name: "relay'laptop",
      projects,
      kinds: "review_decision,herdr_prompt",
      herdrSockets: ["/s<1>.sock"],
      maxAge: "12h",
      pathEnv: "/opt/a&b:/usr/bin",
    });
  });

  it("puts bd's and herdr's directories first on PATH, each once, and skips a missing herdr", () => {
    assert.equal(servicePathEnv({ bd: "/usr/bin/bd", herdr: null }), "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(servicePathEnv({ bd: BD, herdr: "/opt/homebrew/bin/herdr" }), "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("checkInState", () => {
  it("looks for a check-in after the latest start only", () => {
    const old = "[relay] relay/1 starting as r for https://j; bd /x/bd\n[relay] checked in to https://j as r (every 30 s)\n";
    assert.deepEqual(checkInState(`${old}[relay] relay/1 starting as r for https://j; bd /x/bd\n[relay] check-in failed: …\n`), { started: true, checkedIn: false, line: null });
    assert.equal(checkInState(old).checkedIn, true);
    assert.deepEqual(checkInState(""), { started: false, checkedIn: false, line: null });
  });
});

/** A fake launchctl: `bootout` says not loaded until a `bootstrap`; then `print` reports running, and the relay "logs" a check-in. */
function fakeDeps(home, { argv, findOnPath = (b) => ({ bd: BD, herdr: HERDR })[b] ?? null, readTokenFile = () => "bdt_x", checksIn = true } = {}) {
  const calls = [];
  const outLines = [];
  const warnLines = [];
  let loaded = false;
  let clock = 0;
  const paths = servicePaths(home);
  return {
    calls,
    outLines,
    warnLines,
    deps: {
      argv,
      platform: "darwin",
      homedir: home,
      uid: UID,
      execPath: NODE,
      repoRoot: REPO,
      findOnPath,
      readTokenFile,
      checkoutProblem: () => null,
      out: (l) => outLines.push(l),
      warn: (l) => warnLines.push(l),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        assert.equal(cmd, "launchctl", "only launchctl is run");
        if (args[0] === "bootout") {
          if (!loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
          loaded = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "bootstrap") {
          loaded = true;
          if (checksIn) await fs.appendFile(paths.outLog, "[relay] relay/1 starting as relay-laptop for https://jetson.ts.net; bd /opt/homebrew/bin/bd\n[relay] checked in to https://jetson.ts.net as relay-laptop (every 30 s)\n");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "print") {
          return loaded ? { code: 0, stdout: `${TARGET} = {\n\tstate = running\n\tpid = 4242\n}`, stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
        }
        throw new Error(`unexpected launchctl ${args.join(" ")}`);
      },
    },
  };
}

describe("runService (temp HOME, fake launchctl)", () => {
  it("installs: checks the token file, resolves bd and herdr, writes the plist, bootstraps, and waits for the check-in", async () => {
    const home = await tempHome();
    const checked = [];
    const { deps, calls, outLines } = fakeDeps(home, {
      argv: ["install", "--url", "https://jetson.ts.net", "--name", "relay-laptop", ...P],
      readTokenFile: (file) => {
        checked.push(file);
        return "bdt_never_printed";
      },
    });
    const { exitCode } = await runService(deps);
    assert.equal(exitCode, 0);
    const paths = servicePaths(home);
    assert.deepEqual(checked, [paths.defaultTokenFile]);
    assert.deepEqual(calls[0], ["launchctl", "bootout", TARGET]);
    assert.ok(calls.some((c) => c[1] === "bootstrap" && c[2] === `gui/${UID}` && c[3] === paths.plist));
    const plist = readPlist(await fs.readFile(paths.plist, "utf8"));
    assert.equal(plist.tokenFile, paths.defaultTokenFile);
    assert.equal(plist.pathEnv, "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert.ok(outLines.some((l) => l.includes("check-in") && l.includes("[relay] checked in")));
    assert.ok(!outLines.join("\n").includes("bdt_"), "the token is never printed");
  });

  it("makes the logs directory 0700 and the log files 0600, narrowing ones already there", async () => {
    const home = await tempHome();
    const paths = servicePaths(home);
    await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o755 });
    await fs.chmod(paths.logsDir, 0o755);
    await fs.writeFile(paths.errLog, "old\n", { mode: 0o644 });
    await fs.chmod(paths.errLog, 0o644);
    const { deps } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", ...P] });
    assert.equal((await runService(deps)).exitCode, 0);
    assert.equal(statSync(paths.logsDir).mode & 0o777, 0o700);
    assert.equal(statSync(paths.errLog).mode & 0o777, 0o600);
    assert.equal(statSync(paths.outLog).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(paths.errLog, "utf8"), "old\n");

    const fresh = await tempHome();
    const second = fakeDeps(fresh, { argv: ["install", "--url", "https://j", "--name", "r", ...P] });
    assert.equal((await runService(second.deps)).exitCode, 0);
    assert.equal(statSync(servicePaths(fresh).logsDir).mode & 0o777, 0o700);
    assert.equal(statSync(servicePaths(fresh).outLog).mode & 0o777, 0o600);
  });

  it("refuses a log file that is a symlink", async () => {
    const home = await tempHome();
    const paths = servicePaths(home);
    await fs.mkdir(paths.logsDir, { recursive: true });
    symlinkSync(path.join(home, "elsewhere"), paths.outLog);
    const { deps, warnLines } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", ...P] });
    assert.equal((await runService(deps)).exitCode, 1);
    assert.match(warnLines.join("\n"), /relay\.out\.log is not a regular file/);
  });

  it("refuses a --project path that is not a beads checkout at its real path, writing nothing", async () => {
    const home = await tempHome();
    const checkout = path.join(home, "checkout");
    mkdirSync(checkout);
    const { deps, calls, warnLines } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", "--project", `bd=${checkout}`] });
    delete deps.checkoutProblem;
    assert.equal((await runService(deps)).exitCode, 1);
    assert.match(warnLines.join("\n"), /--project bd: .* has no \.beads\/ directory/);
    assert.deepEqual(calls, []);
    mkdirSync(path.join(checkout, ".beads"));
    const ok = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", "--project", `bd=${checkout}`] });
    delete ok.deps.checkoutProblem;
    assert.equal((await runService(ok.deps)).exitCode, 0);
    assert.deepEqual(readPlist(await fs.readFile(servicePaths(home).plist, "utf8")).projects, [{ key: "bd", path: checkout }]);
  });

  it("refuses to install with a bad token file or without bd, writing nothing", async () => {
    for (const opts of [
      { readTokenFile: () => {
          throw new Error("token file /t has mode 0644, readable or writable by others; run: chmod 600 /t");
        } },
      { findOnPath: () => null },
    ]) {
      const home = await tempHome();
      const { deps, calls, warnLines } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", ...P], ...opts });
      const { exitCode } = await runService(deps);
      assert.equal(exitCode, 1);
      assert.deepEqual(calls, []);
      assert.match(warnLines.join("\n"), /chmod 600|bd is not on PATH/);
      await assert.rejects(fs.access(servicePaths(home).plist));
    }
  });

  it("warns without herdr and leaves it off PATH", async () => {
    const home = await tempHome();
    const { deps, warnLines } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", ...P], findOnPath: (b) => (b === "bd" ? BD : null) });
    assert.equal((await runService(deps)).exitCode, 0);
    assert.match(warnLines.join("\n"), /herdr is not on PATH/);
    assert.equal(readPlist(await fs.readFile(servicePaths(home).plist, "utf8")).pathEnv, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("fails install when no check-in appears before the deadline", async () => {
    const home = await tempHome();
    const { deps, warnLines } = fakeDeps(home, { argv: ["install", "--url", "https://j", "--name", "r", ...P], checksIn: false });
    assert.equal((await runService(deps)).exitCode, 1);
    assert.match(warnLines.join("\n"), new RegExp(`no check-in after ${CHECK_IN_DEADLINE_MS / 1000}s`));
  });

  it("reports status with the service's bd and herdr, then uninstalls", async () => {
    const home = await tempHome();
    const installed = fakeDeps(home, { argv: ["install", "--url", "https://jetson.ts.net", "--name", "relay-laptop", ...P] });
    assert.equal((await runService(installed.deps)).exitCode, 0);

    const seenPaths = [];
    const status = fakeDeps(home, {
      argv: ["status"],
      findOnPath: (b, pathEnv) => {
        seenPaths.push(pathEnv);
        return ({ bd: BD, herdr: HERDR })[b] ?? null;
      },
    });
    // The same fake launchd: loaded and running.
    status.deps.run = installed.deps.run;
    assert.equal((await runService(status.deps)).exitCode, 0);
    const text = status.outLines.join("\n");
    assert.match(text, /service {5}dev\.breakdown\.relay: loaded \(state = running, pid = 4242\)/);
    assert.match(text, /bd {10}\/opt\/homebrew\/bin\/bd/);
    assert.match(text, /herdr {7}\/Users\/me\/\.local\/bin\/herdr/);
    assert.match(text, /projects {4}bd=\/Users\/me\/dev\/bd/);
    assert.match(text, /sockets {5}herdr's default/);
    assert.match(text, /check-in {4}\[relay\] checked in/);
    assert.deepEqual(seenPaths, ["/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"]);

    const removed = fakeDeps(home, { argv: ["uninstall"] });
    removed.deps.run = installed.deps.run;
    assert.equal((await runService(removed.deps)).exitCode, 0);
    assert.match(removed.outLines.join("\n"), /stopped and unloaded dev\.breakdown\.relay/);
    await assert.rejects(fs.access(servicePaths(home).plist));
  });

  it("is macOS-only", async () => {
    const { deps, warnLines } = fakeDeps(await tempHome(), { argv: ["status"] });
    assert.equal((await runService({ ...deps, platform: "linux" })).exitCode, 1);
    assert.match(warnLines.join("\n"), /macOS-only/);
  });
});
