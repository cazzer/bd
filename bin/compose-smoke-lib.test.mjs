import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SmokeFailure, TOKEN_OUTPUT, composeArgs, formatTable, limitProblems, parseInspect, parseMemoryPeak,
  parseStatsMemUsage, sumLimits,
} from "./compose-smoke-lib.mjs";

const MiB = 1024 ** 2;

describe("composeArgs", () => {
  test("always names the smoke project and the app compose file", () => {
    assert.deepEqual(composeArgs(["down", "-v"]), ["compose", "-p", "breakdown-smoke", "-f", "docker-compose.app.yml", "down", "-v"]);
  });

  test("refuses the dev database's project and the local app's", () => {
    assert.throws(() => composeArgs(["down", "-v"], { project: "bd" }), SmokeFailure);
    assert.throws(() => composeArgs(["down", "-v"], { project: "breakdown" }), /holds real data/);
  });
});

const inspected = (overrides = {}) => ({
  Name: "/breakdown-smoke-breakdown-db-1",
  RestartCount: 0,
  Config: { Labels: { "com.docker.compose.service": "breakdown-db" } },
  HostConfig: { Memory: 384 * MiB, MemorySwap: 384 * MiB, NanoCpus: 1e9 },
  State: { OOMKilled: false },
  ...overrides,
});

describe("parseInspect", () => {
  test("reads limits, OOM, and restarts per container", () => {
    assert.deepEqual(parseInspect(JSON.stringify([inspected()])), [{
      name: "breakdown-smoke-breakdown-db-1",
      service: "breakdown-db",
      memory: 384 * MiB,
      memorySwap: 384 * MiB,
      nanoCpus: 1e9,
      oomKilled: false,
      restartCount: 0,
    }]);
  });

  test("an unlimited container reads as zero limits", () => {
    const [c] = parseInspect(JSON.stringify([inspected({ HostConfig: { Memory: 0, MemorySwap: 0, NanoCpus: 0 } })]));
    assert.equal(c.memory, 0);
    assert.equal(c.nanoCpus, 0);
  });

  test("a non-array is refused", () => {
    assert.throws(() => parseInspect("{}"), SmokeFailure);
  });
});

describe("parseMemoryPeak", () => {
  test("one integer line", () => {
    assert.equal(parseMemoryPeak("104857600\n"), 104857600);
  });

  test("anything else is refused", () => {
    assert.throws(() => parseMemoryPeak("cat: /sys/fs/cgroup/memory.peak: No such file or directory"), SmokeFailure);
    assert.throws(() => parseMemoryPeak(""), SmokeFailure);
  });
});

describe("parseStatsMemUsage", () => {
  test("binary units", () => {
    assert.deepEqual(parseStatsMemUsage("41.5MiB / 384MiB"), { used: Math.round(41.5 * MiB), limit: 384 * MiB });
    assert.deepEqual(parseStatsMemUsage("1.2GiB / 7.6GiB"), { used: Math.round(1.2 * 1024 ** 3), limit: Math.round(7.6 * 1024 ** 3) });
    assert.deepEqual(parseStatsMemUsage("512KiB / 512MiB"), { used: 512 * 1024, limit: 512 * MiB });
  });

  test("decimal units and bytes", () => {
    assert.deepEqual(parseStatsMemUsage("0B / 0B"), { used: 0, limit: 0 });
    assert.deepEqual(parseStatsMemUsage("12.5MB / 1GB"), { used: 12_500_000, limit: 1e9 });
  });

  test("malformed values are refused", () => {
    assert.throws(() => parseStatsMemUsage("--"), SmokeFailure);
    assert.throws(() => parseStatsMemUsage("12XB / 1GB"), SmokeFailure);
  });
});

describe("limits", () => {
  const db = { service: "breakdown-db", memory: 384 * MiB, memorySwap: 384 * MiB, nanoCpus: 1e9, oomKilled: false, restartCount: 0 };
  const app = { service: "breakdown", memory: 512 * MiB, memorySwap: 512 * MiB, nanoCpus: 1.5e9, oomKilled: false, restartCount: 0 };

  test("the two caps sum to 896 MiB, under 1 GB", () => {
    assert.equal(sumLimits([db, app]), 896 * MiB);
    assert.ok(sumLimits([db, app]) < 1e9);
  });

  test("a container within its caps has no problems", () => {
    assert.deepEqual(limitProblems({ ...db, peak: 100 * MiB }), []);
  });

  test("each broken cap is named", () => {
    assert.deepEqual(
      limitProblems({ ...app, memory: 0, memorySwap: -1, nanoCpus: 0, oomKilled: true, restartCount: 2 }),
      ["no memory limit", "memswap -1 is not the memory limit 0", "no cpu limit", "OOM killed", "restarted 2 time(s)"],
    );
    assert.deepEqual(limitProblems({ ...app, memorySwap: 1024 * MiB }), [`memswap ${1024 * MiB} is not the memory limit ${512 * MiB}`]);
    assert.deepEqual(limitProblems({ ...app, peak: 512 * MiB }), [`peak ${512 * MiB} reached the limit ${512 * MiB}`]);
  });

  test("the table has a row per container and a total", () => {
    const lines = formatTable([{ ...db, peak: 96 * MiB, peakSource: "cgroup" }, { ...app, peak: 128 * MiB, peakSource: "stats" }]);
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^breakdown-db\s+384\.0 MiB\s+384\.0 MiB\s+1\.00\s+96\.0 MiB\s+25%\s+false\s+0$/);
    assert.match(lines[2], /128\.0 MiB \(stats\)\s+25%/);
    assert.match(lines[3], /^total\s+896\.0 MiB$/);
  });
});

describe("TOKEN_OUTPUT", () => {
  test("the token alone on one line", () => {
    assert.match(`bdt_${"A".repeat(43)}\n`, TOKEN_OUTPUT);
    assert.doesNotMatch(`bdt_${"A".repeat(43)}`, TOKEN_OUTPUT);
    assert.doesNotMatch(`> @breakdown/core\nbdt_${"A".repeat(43)}\n`, TOKEN_OUTPUT);
  });
});
