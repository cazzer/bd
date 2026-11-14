// The real stack end to end (client-access spec, "Web write from the phone",
// "Worker cannot approve its own request"): tRPC's standalone handler with
// the production context factory and router, behind the request dispatcher,
// verifying tokens against the real store. dispatch.test.ts proves routing
// with stand-in handlers; this proves the admitted client actually reaches
// a write's ingest run through `admittedClients` and `createContextFactory`,
// and that an `agent` token reaches exactly its procedures (hangar-queue
// decision 5): it files, reads, and completes inbox requests, and every
// decision stays a person's.
//
// Requests come from a loopback peer with a tailnet Host, which admission
// does not trust without a token (dispatch.test.ts's header). Fixtures are
// scoped: tokens under names unique to this file, deleted by name; inbox
// items under a key prefix unique to this run; notes and runs deleted by id.

import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClientToken, verifyClientToken } from "@breakdown/core";
import { clientTokens, createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContextFactory } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";
import { appRouter } from "./router.js";

const TAILNET = "breakdown.tail.example";
const suffix = randomUUID().slice(0, 8);
const HUMAN = `adm-phone-${suffix}`;
const AGENT = `adm-worker-${suffix}`;
const KEY = `session:adm-trpc-${suffix}`;

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
    health: async (_req, res) => void res.writeHead(500).end(),
    reviewImages: async (_req, res) => void res.writeHead(500).end(),
    trpc: createHTTPHandler({ router: appRouter, createContext: createContextFactory(db), basePath: "/trpc/" }),
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdNodes.length > 0) await db.delete(nodes).where(inArray(nodes.id, createdNodes));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), like(nodes.externalId, `${KEY}%`)));
  if (createdRuns.length > 0) await db.delete(ingestRuns).where(inArray(ingestRuns.id, createdRuns));
  await db.delete(clientTokens).where(inArray(clientTokens.client, [HUMAN, AGENT]));
  await pool.end();
});

interface Sent {
  status: number;
  body: string;
}

/** One tRPC call over raw HTTP (fetch forbids setting Host): a query as GET with `?input=`, a mutation as a POST body. */
function call(token: string, kind: "query" | "mutation", procedure: string, input: unknown): Promise<Sent> {
  const path = kind === "query" ? `/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}` : `/trpc/${procedure}`;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: kind === "query" ? "GET" : "POST",
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
    req.end(kind === "mutation" ? JSON.stringify(input) : undefined);
  });
}

function createNote(token: string, title: string): Promise<Sent> {
  return call(token, "mutation", "createNote", { title, content: "written over the tailnet" });
}

function dataOf<T>(sent: Sent): T {
  expect(sent.status, sent.body).toBe(200);
  return (JSON.parse(sent.body) as { result: { data: T } }).result.data;
}

async function runsBy(actor: string): Promise<string[]> {
  return (await db.select({ id: ingestRuns.id }).from(ingestRuns).where(eq(ingestRuns.actor, actor))).map((r) => r.id).sort();
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

  it("refuses an agent token's note with 403 and writes nothing", async () => {
    const title = `admission agent note ${suffix}`;
    const sent = await createNote(tokens[AGENT]!, title);
    expect(sent.status, sent.body).toBe(403);
    expect(JSON.parse(sent.body)).toMatchObject({ error: { message: "An agent token cannot call createNote.", data: { code: "FORBIDDEN", httpStatus: 403 } } });
    const written = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.title, title));
    expect(written).toEqual([]);
  });
});

describe("an agent token on the web API", () => {
  it("files an inbox request, reads the inbox, and completes the item once a person accepts; every decision is refused and writes nothing", async () => {
    const worker = tokens[AGENT]!;
    const requested = dataOf<{ id: string; ingestRunId: string; status: string }>(
      await call(worker, "mutation", "inboxRequest", { key: `${KEY}-flow`, title: `agent request ${suffix}`, content: "may I?", metadata: { source: "session" } }),
    );
    createdRuns.push(requested.ingestRunId);
    expect(requested.status).toBe("pending");
    const [requestRun] = await db.select({ actor: ingestRuns.actor, sourceSystem: ingestRuns.sourceSystem }).from(ingestRuns).where(eq(ingestRuns.id, requested.ingestRunId));
    expect(requestRun).toEqual({ actor: AGENT, sourceSystem: "agent" });

    const listed = dataOf<{ items: { id: string }[]; truncated: boolean }>(await call(worker, "query", "inbox", { statuses: ["pending"] }));
    if (!listed.truncated) expect(listed.items.map((i) => i.id)).toContain(requested.id);

    const [before] = await db.select({ metadata: nodes.metadata, content: nodes.content, updatedAt: nodes.updatedAt }).from(nodes).where(eq(nodes.id, requested.id));
    const refused: [string, unknown][] = [
      ["inboxDecision", { id: requested.id, decision: "accept" }],
      ["inboxRelease", { id: requested.id }],
      ["reviewDecision", { project: "bd", item: "bd-1", decision: "accept", message: "" }],
      ["reviewSession", { project: "bd", item: "bd-1", mode: "open" }],
      ["createNote", { title: `agent refused note ${suffix}`, content: "no" }],
    ];
    for (const [procedure, input] of refused) {
      const sent = await call(worker, "mutation", procedure, input);
      expect(sent.status, `${procedure}: ${sent.body}`).toBe(403);
      expect(JSON.parse(sent.body), procedure).toMatchObject({ error: { message: `An agent token cannot call ${procedure}.` } });
    }
    const [after] = await db.select({ metadata: nodes.metadata, content: nodes.content, updatedAt: nodes.updatedAt }).from(nodes).where(eq(nodes.id, requested.id));
    expect(after).toEqual(before);
    expect(await runsBy(AGENT)).toEqual([requested.ingestRunId]);
    expect(await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.title, `agent refused note ${suffix}`))).toEqual([]);

    const decided = dataOf<{ ingestRunId: string }>(await call(tokens[HUMAN]!, "mutation", "inboxDecision", { id: requested.id, decision: "accept" }));
    createdRuns.push(decided.ingestRunId);

    const completed = dataOf<{ id: string; ingestRunId: string }>(await call(worker, "mutation", "inboxComplete", { id: requested.id, note: "done over the tailnet" }));
    createdRuns.push(completed.ingestRunId);
    const [completeRun] = await db.select({ actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, completed.ingestRunId));
    expect(completeRun?.actor).toBe(AGENT);
    const [done] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, requested.id));
    expect(done?.metadata).toMatchObject({ status: "done" });
  });
});
