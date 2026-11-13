import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { HEAP_MB, LaunchConfigError, migrateWithRetry, planLaunch, readPorts, supervise } from "./container-launch-lib.mjs";

const DB = { DATABASE_URL: "postgres://u:p@breakdown-db:5432/breakdown" };

describe("planLaunch", () => {
  test("DATABASE_URL alone gives the defaults", () => {
    const plan = planLaunch(DB, { appRoot: "/srv/app" });
    assert.deepEqual(plan.migrate, [`--max-old-space-size=${HEAP_MB.migrate}`, "/srv/app/dist/migrate.mjs"]);
    assert.deepEqual(plan.web, [
      "--max-old-space-size=160", "/srv/app/dist/web.mjs",
      "--host", "0.0.0.0", "--port", "4310",
      "--client-dir", "/srv/app/client", "--media-dir", "/data/media",
    ]);
    assert.deepEqual(plan.mcp, ["--max-old-space-size=128", "/srv/app/dist/mcp.mjs", "--host", "0.0.0.0", "--port", "5320"]);
    assert.deepEqual(plan.childEnv, DB);
  });

  test("the app root defaults to /app", () => {
    assert.equal(planLaunch(DB).web[1], "/app/dist/web.mjs");
  });

  test("every setting is read from BREAKDOWN_*", () => {
    const plan = planLaunch({
      ...DB,
      BREAKDOWN_HOST: "100.64.0.7",
      BREAKDOWN_WEB_PORT: "8080",
      BREAKDOWN_MCP_PORT: "8081",
      BREAKDOWN_MEDIA_DIR: "/media",
    });
    assert.deepEqual(plan.web.slice(2), ["--host", "100.64.0.7", "--port", "8080", "--client-dir", "/app/client", "--media-dir", "/media"]);
    assert.deepEqual(plan.mcp.slice(2), ["--host", "100.64.0.7", "--port", "8081"]);
  });

  test("the allowed-host list becomes repeated flags on both servers, empties dropped", () => {
    const plan = planLaunch({ ...DB, BREAKDOWN_ALLOW_HOSTS: " jetson.tail1234.ts.net, ,jetson,," });
    const expected = ["--allow-host", "jetson.tail1234.ts.net", "--allow-host", "jetson"];
    assert.deepEqual(plan.web.slice(6, 10), expected);
    assert.deepEqual(plan.mcp.slice(6), expected);
  });

  test("empty values take their defaults", () => {
    const plan = planLaunch({ ...DB, BREAKDOWN_HOST: " ", BREAKDOWN_WEB_PORT: "", BREAKDOWN_ALLOW_HOSTS: "" });
    assert.deepEqual(plan.web.slice(2, 6), ["--host", "0.0.0.0", "--port", "4310"]);
    assert.equal(plan.mcp.length, 6);
  });

  for (const bad of ["0", "65536", "80a", "-1", "4310.5", "0x10"]) {
    test(`port ${JSON.stringify(bad)} is refused, naming the variable`, () => {
      assert.throws(() => planLaunch({ ...DB, BREAKDOWN_MCP_PORT: bad }), (err) => {
        assert.ok(err instanceof LaunchConfigError);
        assert.match(err.message, /^BREAKDOWN_MCP_PORT=/);
        return true;
      });
    });
  }

  test("equal ports are refused", () => {
    assert.throws(() => planLaunch({ ...DB, BREAKDOWN_WEB_PORT: "5320" }), /BREAKDOWN_WEB_PORT and BREAKDOWN_MCP_PORT are both 5320/);
    assert.throws(() => readPorts({ BREAKDOWN_WEB_PORT: "9000", BREAKDOWN_MCP_PORT: "9000" }), LaunchConfigError);
  });

  test("a missing or empty DATABASE_URL is refused", () => {
    assert.throws(() => planLaunch({}), /DATABASE_URL is not set/);
    assert.throws(() => planLaunch({ DATABASE_URL: "" }), /DATABASE_URL is not set/);
  });

  test("the children's environment drops every BREAKDOWN_* key and keeps the rest", () => {
    const { childEnv } = planLaunch({
      ...DB,
      BRAIN_READ_ONLY: "1",
      PATH: "/usr/bin",
      BREAKDOWN_HOST: "0.0.0.0",
      BREAKDOWN_ALLOW_HOSTS: "jetson",
      BREAKDOWN_SOMETHING_NEW: "x",
    });
    assert.deepEqual(childEnv, { ...DB, BRAIN_READ_ONLY: "1", PATH: "/usr/bin" });
  });
});

describe("migrateWithRetry", () => {
  test("retries until migrate exits 0, sleeping between attempts", async () => {
    const codes = [1, 1, 0];
    const slept = [];
    const lines = [];
    const ok = await migrateWithRetry({
      runMigrate: async () => codes.shift(),
      sleep: async (ms) => slept.push(ms),
      log: (line) => lines.push(line),
      attempts: 5,
      delayMs: 2000,
    });
    assert.equal(ok, true);
    assert.deepEqual(slept, [2000, 2000]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /attempt 1 of 5/);
  });

  test("gives up after the last attempt without a final sleep", async () => {
    const slept = [];
    const ok = await migrateWithRetry({ runMigrate: async () => 1, sleep: async (ms) => slept.push(ms), log: () => {}, attempts: 3, delayMs: 10 });
    assert.equal(ok, false);
    assert.equal(slept.length, 2);
  });
});

describe("supervise", () => {
  function harness({ deadlineMs = 1_000, exitOnSignal = true } = {}) {
    const children = { web: new EventEmitter(), mcp: new EventEmitter() };
    const signals = new EventEmitter();
    const kills = [];
    let resolveExit;
    const exited = new Promise((resolve) => (resolveExit = resolve));
    supervise(children, {
      signals,
      deadlineMs,
      log: () => {},
      exit: (code) => resolveExit(code),
      kill: (child, signal) => {
        const name = child === children.web ? "web" : "mcp";
        kills.push([name, signal]);
        if (exitOnSignal || signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, signal));
      },
    });
    return { children, signals, kills, exited };
  }

  test("one child exiting SIGTERMs the other and exits non-zero", async () => {
    const { children, kills, exited } = harness();
    children.mcp.emit("exit", 0, null);
    assert.equal(await exited, 1);
    assert.deepEqual(kills, [["web", "SIGTERM"]]);
  });

  test("a child that fails to spawn stops the other too", async () => {
    const { children, kills, exited } = harness();
    children.web.emit("error", new Error("spawn ENOENT"));
    assert.equal(await exited, 1);
    assert.deepEqual(kills, [["mcp", "SIGTERM"]]);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`${signal} to the launcher is forwarded to both and exits 0 once both exit`, async () => {
      const { signals, kills, exited } = harness();
      signals.emit(signal);
      assert.equal(await exited, 0);
      assert.deepEqual(kills, [["web", signal], ["mcp", signal]]);
    });
  }

  test("a second signal while stopping does not signal again", async () => {
    const { signals, kills, exited } = harness();
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(kills.length, 2);
  });

  test("children still running at the deadline get SIGKILL and the exit is non-zero", async () => {
    const { signals, kills, exited } = harness({ deadlineMs: 20, exitOnSignal: false });
    signals.emit("SIGTERM");
    assert.equal(await exited, 1);
    assert.deepEqual(kills, [["web", "SIGTERM"], ["mcp", "SIGTERM"], ["web", "SIGKILL"], ["mcp", "SIGKILL"]]);
  });

  test("only the child that outlives the deadline is killed", async () => {
    const { children, kills, exited } = harness({ deadlineMs: 20, exitOnSignal: false });
    children.web.emit("exit", 1, null);
    assert.equal(await exited, 1);
    assert.deepEqual(kills, [["mcp", "SIGTERM"], ["mcp", "SIGKILL"]]);
  });
});
