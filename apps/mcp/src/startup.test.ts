// Fail-fast startup coverage (brain-mcp spec, "Fail fast on
// misconfiguration"). Two layers: unit tests of the pure/DB-facing
// helpers, and one process-level test that actually spawns the real
// entrypoint (src/index.ts) against a dead port and asserts on its exit
// code and stderr — the spec explicitly asks for this ("Test this by
// pointing at a dead port and asserting on the exit and the message"),
// so a unit test of verifyDatabaseConnection alone would not satisfy it.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPool, resolveDatabaseUrl } from "@breakdown/db";
import { afterAll, describe, expect, it } from "vitest";
import { describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

const execFileAsync = promisify(execFile);

describe("describeConnectionTarget", () => {
  it("renders host:port/database without credentials", () => {
    expect(describeConnectionTarget("postgres://user:secret-password@localhost:5442/breakdown")).toBe("localhost:5442/breakdown");
  });

  it("falls back to a default port when none is given", () => {
    expect(describeConnectionTarget("postgres://user:pw@example.com/mydb")).toBe("example.com:5432/mydb");
  });

  it("never includes the password even when parsing succeeds", () => {
    const target = describeConnectionTarget("postgres://breakdown:super-secret@localhost:5442/breakdown");
    expect(target).not.toContain("super-secret");
  });

  it("degrades gracefully for an unparseable string, rather than throwing", () => {
    expect(() => describeConnectionTarget("not a url at all")).not.toThrow();
    expect(describeConnectionTarget("not a url at all")).toMatch(/could not be parsed/i);
  });
});

describe("verifyDatabaseConnection", () => {
  it("resolves against the real, reachable test database", async () => {
    const pool = createPool(resolveDatabaseUrl());
    try {
      await expect(verifyDatabaseConnection(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("rejects when pointed at a port nothing is listening on", async () => {
    const pool = createPool("postgres://breakdown:breakdown@127.0.0.1:1/breakdown");
    try {
      await expect(verifyDatabaseConnection(pool)).rejects.toBeTruthy();
    } finally {
      await pool.end().catch(() => {});
    }
  });
});

describe("server process: fails fast on an unreachable database", () => {
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
  const entry = path.join(mcpRoot, "src", "index.ts");

  it("exits non-zero with a message naming the connection target, without ever completing startup", async () => {
    const deadUrl = "postgres://breakdown:breakdown@127.0.0.1:1/breakdown";

    let stderr = "";
    let code: number | null = 0;
    try {
      await execFileAsync(tsxBin, [entry], {
        env: { ...process.env, DATABASE_URL: deadUrl },
        timeout: 15_000,
      });
      throw new Error("expected the process to exit non-zero, but it succeeded");
    } catch (err) {
      const e = err as { code?: number | null; stderr?: string; killed?: boolean; signal?: string | null };
      if (e.killed) {
        throw new Error(`process was killed (signal ${e.signal}) instead of exiting on its own — stderr so far: ${e.stderr}`);
      }
      code = e.code ?? null;
      stderr = e.stderr ?? "";
    }

    expect(code).not.toBe(0);
    // Actionable: names the connection target (host:port/db) and mentions
    // the database/connectivity, not just a bare failure.
    expect(stderr).toContain("127.0.0.1:1/breakdown");
    expect(stderr).toMatch(/unreachable|cannot start/i);
    expect(stderr).toMatch(/DATABASE_URL/);
  }, 20_000);

  // A "DATABASE_URL entirely unset" variant is not exercised here:
  // @breakdown/db's resolveDatabaseUrl() walks up to the workspace root
  // and loads its .env, which this repo's checked-in .env always
  // supplies — so unsetting the env var alone does not reproduce
  // "unset" for a spawned child process without relocating or deleting
  // the real .env file, which would be invasive for a test. That path is
  // covered functionally by resolveDatabaseUrl's own DatabaseUrlNotSetError
  // (thrown, with an actionable message naming the .env path it looked
  // for) and by index.ts's explicit catch around resolveDatabaseUrl(),
  // which reads and reports err.message the same way the dead-port path
  // does below.
});
