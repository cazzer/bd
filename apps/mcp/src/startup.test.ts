// Fail-fast startup coverage (brain-mcp spec, "Fail fast on
// misconfiguration"). Three layers: unit tests of the pure/DB-facing
// helpers, one process-level test that actually spawns the real
// entrypoint (src/index.ts) against a dead port and asserts on its exit
// code and stderr — the spec explicitly asks for this ("Test this by
// pointing at a dead port and asserting on the exit and the message"),
// so a unit test of verifyDatabaseConnection alone would not satisfy it —
// and a stdout-purity guard, below, covering a failure that no unit test
// can see: one stray line on stdout makes the transport unparseable and
// every brain_* tool unreachable, while the server itself looks healthy.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPool, resolveDatabaseUrl } from "@breakdown/db";
import { afterAll, describe, expect, it } from "vitest";
import { describeConnectionError, describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

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

describe("describeConnectionError", () => {
  it("uses a plain Error's own message", () => {
    expect(describeConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });

  it("unwraps an AggregateError by joining its inner errors' messages (bd-vt2.5 review: AggregateError#message is '' — a dual-stack host, exactly what localhost is, produces exactly this)", () => {
    const agg = new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")], "");
    expect(agg.message).toBe(""); // pin the actual Node behavior this function exists to work around
    const described = describeConnectionError(agg);
    expect(described).toContain("connect ECONNREFUSED ::1:1");
    expect(described).toContain("connect ECONNREFUSED 127.0.0.1:1");
  });

  it("falls back to the AggregateError's own message/name if its inner errors are somehow all blank", () => {
    const agg = new AggregateError([new Error(""), new Error("")], "");
    expect(describeConnectionError(agg)).toBe("AggregateError (no further detail)");
  });

  it("stringifies a non-Error thrown value without crashing", () => {
    expect(describeConnectionError("a plain string")).toBe("a plain string");
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

  it("names the actual connection failure (not an empty detail) when the host is localhost — the dual-stack case .env.example ships and every real setup here uses (bd-vt2.5 review: 127.0.0.1 alone never exercises this)", async () => {
    // Deliberately the realistic case, not 127.0.0.1: a dual-stack
    // `localhost` makes Node try both ::1 and 127.0.0.1 in parallel and,
    // when both fail, reject with a bare AggregateError whose own
    // `.message` is `""` — the spec's "names ... the failure" silently
    // failed for exactly this input, which is the only one a real user
    // hits (see describeConnectionError's own unit tests above for the
    // isolated behavior this end-to-end test confirms index.ts actually
    // wires up).
    const deadUrl = "postgres://breakdown:breakdown@localhost:1/breakdown";

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
    expect(stderr).toContain("localhost:1/breakdown");
    // The actual regression: the parenthesized detail must not be empty
    // ("... is unreachable ()") — it must carry the real ECONNREFUSED
    // detail from at least one of the parallel connection attempts.
    expect(stderr).toMatch(/ECONNREFUSED/);
    expect(stderr).not.toMatch(/unreachable \(\)/);
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

// stdout is the MCP transport, not a log. dotenv's "injected env" banner
// and `pnpm run`'s "> pkg@version start" preamble both went there and broke
// it: the client read `>`, failed to parse, and closed the connection
// (CONNECTION_CLOSED) before the server had answered anything. Nothing
// about the server looked wrong, which is what made it expensive to find.
describe("server process: stdout carries only the JSON-RPC transport", () => {
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
  const entry = path.join(mcpRoot, "src", "index.ts");
  const workspaceRoot = path.resolve(mcpRoot, "..", "..");

  it("replies to initialize with a line a stdio client can parse from its first byte", async () => {
    const child = spawn(tsxBin, [entry], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const firstLine = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline !== -1) resolve(stdout.slice(0, newline));
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`exited ${code} before replying — stdout=${JSON.stringify(stdout)} stderr=${stderr}`)),
      );
    });
    const expired = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no line on stdout within 20 s — stdout=${JSON.stringify(stdout)} stderr=${stderr}`)), 20_000).unref(),
    );

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdout-guard", version: "0" } },
      })}\n`,
    );

    try {
      const line = await Promise.race([firstLine, expired]);
      // The assertion that matters: the very first byte, not "contains JSON
      // somewhere". A banner ahead of the frame is exactly what broke this.
      expect(line.startsWith("{")).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0", id: 1 });
      // Startup diagnostics are still expected — on stderr, where they belong.
      expect(stderr).toContain("[breakdown-brain] ready on stdio");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  it("is launched by .mcp.json with pnpm's run preamble suppressed", () => {
    const config = JSON.parse(readFileSync(path.join(workspaceRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const brain = config.mcpServers["brain"];
    expect(brain).toBeDefined();
    // `pnpm run` prints "> @breakdown/mcp@0.0.0 start" to stdout. The server
    // cannot defend against its own launcher, so the config carries the fix;
    // drop --silent and the transport breaks again with the server untouched.
    if (brain!.command === "pnpm") expect(brain!.args).toContain("--silent");
  });
});
