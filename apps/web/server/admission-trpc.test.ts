// The real stack end to end (client-access spec, "Web write from the phone",
// "Worker cannot approve its own request"): tRPC's standalone handler with
// the production context factory and router, behind the request dispatcher,
// verifying tokens against the real store. dispatch.test.ts proves routing
// with stand-in handlers; this proves the admitted client actually reaches
// a write's ingest run through `admittedClients` and `createContextFactory`.
//
// Requests come from a loopback peer with a tailnet Host, which admission
// does not trust without a token (dispatch.test.ts's header). Fixtures are
// scoped: tokens under names unique to this file, deleted by name; the note
// and its run deleted by id.

import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClientToken, verifyClientToken } from "@breakdown/core";
import { clientTokens, createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContextFactory } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";
import { appRouter } from "./router.js";

const TAILNET = "breakdown.tail.example";
const suffix = randomUUID().slice(0, 8);
const HUMAN = `adm-phone-${suffix}`;
const AGENT = `adm-worker-${suffix}`;

let pool: ReturnType<typeof createPool>;
let db: Database;
let server: Server;
let port: number;
const tokens: Record<string, string> = {};
const createdNodes: string[] = [];
const createdRuns: string[] = [];

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  tokens[HUMAN] = (await createClientToken(db, HUMAN, "human")).token;
  tokens[AGENT] = (await createClientToken(db, AGENT, "agent")).token;

  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  server = createServer((req, res) => dispatch!(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  dispatch = createRequestDispatcher({
    port,
    allowedHosts: [TAILNET],
    verifyToken: (token) => verifyClientToken(db, token),
    connect: async (_req, res) => void res.writeHead(500).end(),
    reviewImages: async (_req, res) => void res.writeHead(500).end(),
    trpc: createHTTPHandler({ router: appRouter, createContext: createContextFactory(db), basePath: "/trpc/" }),
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdNodes.length > 0) await db.delete(nodes).where(inArray(nodes.id, createdNodes));
  if (createdRuns.length > 0) await db.delete(ingestRuns).where(inArray(ingestRuns.id, createdRuns));
  await db.delete(clientTokens).where(inArray(clientTokens.client, [HUMAN, AGENT]));
  await pool.end();
});

function createNote(token: string, title: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/trpc/createNote",
        method: "POST",
        headers: { Host: `${TAILNET}:${port}`, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ title, content: "written over the tailnet" }));
  });
}

describe("a tokened web write through the real tRPC handler", () => {
  it("records the human token's client as the run's actor, under source system human", async () => {
    const sent = await createNote(tokens[HUMAN]!, `admission note ${suffix}`);
    expect(sent.status, sent.body).toBe(200);
    const { id, ingestRunId } = (JSON.parse(sent.body) as { result: { data: { id: string; ingestRunId: string } } }).result.data;
    createdNodes.push(id);
    createdRuns.push(ingestRunId);

    const [run] = await db.select({ actor: ingestRuns.actor, sourceSystem: ingestRuns.sourceSystem }).from(ingestRuns).where(eq(ingestRuns.id, ingestRunId));
    expect(run).toEqual({ actor: HUMAN, sourceSystem: "human" });
  });

  it("refuses an agent token with 403 and writes nothing", async () => {
    const title = `admission agent note ${suffix}`;
    const sent = await createNote(tokens[AGENT]!, title);
    expect(sent).toEqual({ status: 403, body: "Forbidden\n" });
    const written = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.title, title));
    expect(written).toEqual([]);
  });
});
