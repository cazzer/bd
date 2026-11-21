// brain_register_project (register-beads-project) through the real MCP
// protocol. Fixtures are this file's own keys, removed by key afterwards.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getRelayAction } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, relayActions, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "./server.js";

const SUFFIX = randomUUID().slice(0, 8);
const keyOf = (name: string) => `mrp-${name}-${SUFFIX}`;
const CLIENT = { name: "register-project-test", version: `0.0.0+${SUFFIX}` };
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-register-project-")));
const PLAIN = path.join(ROOT, "plain");
mkdirSync(PLAIN);

let pool: ReturnType<typeof createPool>;
let db: Database;

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await db.delete(relayActions).where(sql`${relayActions.payload}->>'project_key' LIKE ${`mrp-%-${SUFFIX}`}`);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), like(nodes.externalId, `project:mrp-%-${SUFFIX}`)));
  await db.delete(ingestRuns).where(inArray(ingestRuns.actor, [`${CLIENT.name} ${CLIENT.version}`, `tok via ${CLIENT.name} ${CLIENT.version}`]));
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

async function connect(opts: CreateServerOptions): Promise<Client> {
  const server = createServer(db, opts);
  const client = new Client(CLIENT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(raw: any): string {
  return raw.content?.[0]?.text as string;
}

describe("brain_register_project", () => {
  it("registers on a server without bd, attributes the run, queues a re-ingest, then reports unchanged", async () => {
    const client = await connect({ bdAvailable: false, tokenClient: "tok" });
    const project = keyOf("a");
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project, path: "/Users/nobody/dev/underground" } });
    expect(raw.isError, textOf(raw)).toBeFalsy();
    const result = JSON.parse(textOf(raw));
    expect(result).toMatchObject({ project, path: "/Users/nobody/dev/underground", status: "created" });
    expect(result.pickup).toContain(`--project ${project}=/Users/nobody/dev/underground`);
    const [run] = await db.select().from(ingestRuns).where(eq(ingestRuns.id, result.ingestRunId));
    expect(run).toMatchObject({ sourceSystem: "beads", actor: `tok via ${CLIENT.name} ${CLIENT.version}` });
    const actionId = Number(/re-ingest (\d+)/.exec(result.pickup)![1]);
    expect(await getRelayAction(db, actionId)).toMatchObject({ kind: "beads_reingest", payload: { project_key: project } });

    const again = JSON.parse(textOf(await client.callTool({ name: "brain_register_project", arguments: { project, path: "/Users/nobody/dev/underground" } })));
    expect(again.status).toBe("unchanged");
  });

  it("returns a conflict naming both paths and does not re-point the key", async () => {
    const client = await connect({ bdAvailable: false });
    const project = keyOf("b");
    await client.callTool({ name: "brain_register_project", arguments: { project, path: "/Users/me/dev/one" } });
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project, path: "/Users/me/dev/two" } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toContain("/Users/me/dev/one");
    expect(textOf(raw)).toContain("/Users/me/dev/two");
    expect(textOf(raw)).toMatch(/never moves a project/);
  });

  it("checks the path here when bd is on this host", async () => {
    const client = await connect({ bdAvailable: true });
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project: keyOf("c"), path: PLAIN } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toContain("holds no .beads/");
  });

  it("refuses a malformed key with the key's rule", async () => {
    const client = await connect({ bdAvailable: false });
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project: "Under Ground", path: "/Users/me/x" } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/lowercase letters, digits/);
  });

  it("is neither listed nor run for a hangar session token", async () => {
    const client = await connect({ bdAvailable: false, hangarSessionId: randomUUID() });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("brain_register_project");
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project: keyOf("d"), path: "/Users/me/x" } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/not available to a hangar session/);
  });

  it("is refused read-only", async () => {
    const client = await connect({ bdAvailable: false, readOnly: true });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("brain_register_project");
    const raw = await client.callTool({ name: "brain_register_project", arguments: { project: keyOf("e"), path: "/Users/me/x" } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/read-only/i);
  });
});
