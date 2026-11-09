// The real stdio entrypoint (src/index.ts), spawned as a child process and
// driven by the SDK's own stdio client: a write made over stdio still
// records the connected client as its actor once the startup steps moved
// into bootstrap.ts (shared-mcp-server, task 1.2). server.test.ts covers
// attribution over an in-memory transport; this is the transport a Claude
// session actually uses.
//
// The database is shared with live sessions, so the fixture is scoped to
// a unique source system and external id and removed afterwards by the
// ingest run that wrote it, with the source system as a backstop in case
// the response (and so the run id) never arrives — never by a global
// sweep.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
const entry = path.join(mcpRoot, "src", "index.ts");

let pool: ReturnType<typeof createPool>;
let db: Database;
const runIds: string[] = [];
const suffix = randomUUID().replace(/-/g, "");
const sourceSystem = `mcp-stdio-${suffix}`;

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await db.delete(nodes).where(eq(nodes.sourceSystem, sourceSystem));
  for (const id of runIds) {
    await db.delete(nodes).where(eq(nodes.ingestRunId, id));
    await db.delete(ingestRuns).where(eq(ingestRuns.id, id));
  }
  await pool.end();
});

describe("server process over stdio", () => {
  it("records the connecting client as the actor on a write's ingest run", async () => {
    const clientName = `stdio-actor-${suffix}`;
    const client = new Client({ name: clientName, version: "9.9.9" });
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [entry],
      env: process.env as Record<string, string>,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await client.connect(transport).catch((err: unknown) => {
        throw new Error(`connect failed: ${String(err)} — stderr=${stderr}`);
      });
      const raw = await client.callTool({
        name: "brain_write",
        arguments: { items: { nodeType: "doc", externalId: `stdio-actor-${suffix}`, sourceSystem, content: "c" } },
      });
      const content = raw.content as { type: string; text: string }[];
      expect(raw.isError, `brain_write failed: ${content[0]?.text} — stderr=${stderr}`).toBeFalsy();
      const result = JSON.parse(content[0]!.text) as { ingestRunId: string };
      runIds.push(result.ingestRunId);

      const [run] = await db
        .select({ sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor })
        .from(ingestRuns)
        .where(eq(ingestRuns.id, result.ingestRunId));
      expect(run, `stderr=${stderr}`).toEqual({ sourceSystem: "agent", actor: `${clientName} 9.9.9` });
    } finally {
      await client.close();
    }
  }, 30_000);
});
