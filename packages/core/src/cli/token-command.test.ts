// token-command.ts driven in-process, plus one spawn of the real entrypoint
// (token.ts) to prove stdout carries the token line and nothing else
// (client-access spec, "Create and use"). Every test uses its own client
// names and deletes its own rows.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clientTokens, type Database } from "@breakdown/db";
import { connectTestDb, uniqueSuffix, type TestPool } from "../test-helpers.js";
import { runTokenCli } from "./token-command.js";

const TOKEN_LINE = /^bdt_[A-Za-z0-9_-]{43}\n$/;

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(coreRoot, "node_modules", ".bin", "tsx");
const entry = path.join(coreRoot, "src", "cli", "token.ts");

let pool: TestPool;
let db: Database;
const created: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  const clients = created.splice(0);
  if (clients.length > 0) await db.delete(clientTokens).where(inArray(clientTokens.client, clients));
});

afterAll(async () => {
  await pool.end();
});

function clientName(): string {
  const name = `cli-${uniqueSuffix().slice(0, 16)}`;
  created.push(name);
  return name;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runTokenCli(argv, { db, out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

describe("runTokenCli", () => {
  it("create prints only the token line on stdout, and the row holds only its hash", async () => {
    const client = clientName();
    const { code, out, err } = await run(["create", client]);
    expect(code).toBe(0);
    expect(out).toMatch(TOKEN_LINE);
    expect(err).toContain("shown once");
    expect(err).not.toContain("bdt_");

    const token = out.trimEnd();
    const rows = await db.select().from(clientTokens).where(eq(clientTokens.client, client));
    expect(rows).toHaveLength(1);
    expect(Buffer.compare(rows[0]!.tokenHash, createHash("sha256").update(token).digest())).toBe(0);
    expect(JSON.stringify(rows[0])).not.toContain(token.slice(4));
  });

  it("create refuses a live duplicate with exit 1 and nothing on stdout", async () => {
    const client = clientName();
    await run(["create", client]);
    const { code, out, err } = await run(["create", client]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain(`pnpm -s client-token revoke ${client}`);
  });

  it("list shows live and revoked clients and never a token", async () => {
    const live = clientName();
    const gone = clientName();
    await run(["create", live]);
    await run(["create", gone]);
    await run(["revoke", gone]);

    const { code, out } = await run(["list"]);
    expect(code).toBe(0);
    expect(out).not.toContain("bdt_");
    const lines = out.split("\n");
    const liveLine = lines.find((l) => l.startsWith(`${live}\t`));
    const goneLine = lines.find((l) => l.startsWith(`${gone}\t`));
    expect(liveLine).toMatch(/\tlast used never\tlive$/);
    expect(goneLine).toMatch(/\trevoked \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("revoke confirms on stderr, and a second revoke exits 1", async () => {
    const client = clientName();
    await run(["create", client]);
    const first = await run(["revoke", client]);
    expect(first).toMatchObject({ code: 0, out: "" });
    expect(first.err).toContain(client);
    const second = await run(["revoke", client]);
    expect(second.code).toBe(1);
    expect(second.err).toContain("no live token");
  });

  it("refuses an invalid client name with exit 1", async () => {
    const { code, out } = await run(["create", "bad name"]);
    expect(code).toBe(1);
    expect(out).toBe("");
  });

  it.each([[[]], [["create"]], [["create", "a", "b"]], [["list", "extra"]], [["revoke"]], [["mint", "x"]]])(
    "exits 2 with usage for %j",
    async (argv) => {
      const { code, out, err } = await run(argv);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toMatch(/^usage:/);
    },
  );
});

describe("token.ts entrypoint", () => {
  it("create writes exactly the token line to stdout and exits 0", async () => {
    const client = clientName();
    const child = spawn(tsxBin, [entry, "create", client], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(TOKEN_LINE);
  }, 20_000);
});
