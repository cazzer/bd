// `hangarStatus` over the real router and database (hangar-queue design
// decision 7). The database is shared with live data and with suites that
// check hangar in in parallel, so this asserts the shape and the rules that
// hold whichever hangar checked in last, never a particular liveness state.
// `hangarSessionOutcome` and an outcome request's inbox decision
// (hangar-release) run on this file's own session nodes, written straight to
// the store and never queued, so no real hangar can claim them.

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, recordCheckIn, requestHangarOutcome, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, hangarCheckIns, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

const HANGAR = `test-hgstatus-${randomUUID().slice(0, 8)}`;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const PERSON = `${HANGAR}-person`;
const SESSION_NODES: string[] = [];

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;
const caller = (scope: Context["scope"], extra: Partial<Context> = {}) => createCallerFactory(appRouter)({ db, scope, ...extra });

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, `${HANGAR}-fixtures`, { actor: HANGAR });
});

afterAll(async () => {
  await db.delete(hangarCheckIns).where(eq(hangarCheckIns.hangar, HANGAR));
  if (SESSION_NODES.length > 0) {
    await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), inArray(nodes.externalId, SESSION_NODES.map((id) => `hangar-outcome:${id}`))));
    await db.delete(nodes).where(inArray(nodes.id, SESSION_NODES));
  }
  await closeIngestRun(db, run);
  await db.delete(ingestRuns).where(like(ingestRuns.actor, `${HANGAR}%`));
  await pool.end();
});

/** A hangar session node in `state` holding a disk, written straight to the store. */
async function sessionNode(state: string): Promise<string> {
  const result = await upsertNodes(db, run, [
    { nodeType: "hangar_session", sourceSystem: "hangar", externalId: randomUUID(), title: "Hangar headless session: test", metadata: { state, flavor: "headless", repo: "test/repo", claimed_by: HANGAR, disk_path: "/disks/test.img" } },
  ]);
  const id = result.rows[0]!.id;
  SESSION_NODES.push(id);
  return id;
}

const metadataOf = async (id: string): Promise<Record<string, unknown>> => (await db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM nodes WHERE id = ${id}::uuid`)).rows[0]!.metadata;

describe("hangarStatus", () => {
  it("answers liveness, the last hangar, and the open counts with ISO times from the server's clock", async () => {
    await recordCheckIn(db, { hangar: HANGAR, version: "9.9.9" });
    const status = await caller("agent").hangarStatus();
    expect(Object.keys(status).sort()).toEqual(["claimed", "hangar", "intervalS", "lastSeenAt", "now", "queued", "running", "status", "version"]);
    // A check-in just landed, so some hangar has checked in recently.
    expect(status.status).toBe("online");
    expect(status.hangar).toEqual(expect.any(String));
    expect(status.lastSeenAt).toMatch(ISO);
    expect(status.now).toMatch(ISO);
    expect(Date.parse(status.now)).toBeGreaterThanOrEqual(Date.parse(status.lastSeenAt!));
    expect(status.intervalS).toBe(30);
    for (const n of [status.queued, status.claimed, status.running]) expect(Number.isInteger(n) && n >= 0).toBe(true);
  });

  it("serves the local person too, and refuses a hangar token", async () => {
    expect((await caller(null).hangarStatus()).now).toMatch(ISO);
    await expect(caller("hangar").hangarStatus()).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("hangarSessionOutcome", () => {
  it("lets the person table a stopped session, attributed to their client", async () => {
    const id = await sessionNode("stopped");
    const set = await caller("human", { client: PERSON }).hangarSessionOutcome({ id, outcome: "tabled" });
    expect(set).toMatchObject({ id, state: "stopped", outcome: "tabled", outcomeBy: PERSON, released: false, changed: true });
    expect(set.outcomeAt).toMatch(ISO);
    expect(await caller(null, { client: PERSON }).hangarSessionOutcome({ id, outcome: "tabled" })).toMatchObject({ changed: false });
    expect(await caller(null).hangarSessionOutcome({ id, outcome: "accepted" })).toMatchObject({ outcome: "accepted", outcomeBy: "human" });
  });

  it("refuses an agent or hangar token with FORBIDDEN, and a read-only server, changing nothing", async () => {
    const id = await sessionNode("stopped");
    for (const scope of ["agent", "hangar"] as const) {
      const refused = await caller(scope).hangarSessionOutcome({ id, outcome: "tabled" }).catch((e: unknown) => e);
      expect(refused, scope).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await caller("human", { readOnly: true }).hangarSessionOutcome({ id, outcome: "tabled" }).catch((e: unknown) => e)).toMatchObject({ code: "FORBIDDEN" });
    expect((await metadataOf(id))["outcome"]).toBeUndefined();
  });

  it("refuses a running session with CONFLICT naming its state", async () => {
    const id = await sessionNode("running");
    const refused = await caller("human").hangarSessionOutcome({ id, outcome: "accepted" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("is running") });
  });
});

describe("an outcome request's inbox decision", () => {
  it("the person's Table on the item tables the session, attributed to them; a dismiss leaves it unset", async () => {
    const id = await sessionNode("stopped");
    const filed = await requestHangarOutcome(db, { sessionId: id, outcome: "tabled", note: "Merged; the disk can go.", actor: `${HANGAR}-agent` });
    const decided = await caller("human", { client: PERSON }).inboxDecision({ id: filed.id, decision: "accept", option: "table" });
    expect(decided).toMatchObject({ after: "done", sessionOutcome: { sessionId: id, outcome: "tabled" } });
    expect(await metadataOf(id)).toMatchObject({ outcome: "tabled", outcome_by: PERSON });

    const other = await sessionNode("failed");
    const dismissed = await requestHangarOutcome(db, { sessionId: other, outcome: "accepted", note: "Done.", actor: `${HANGAR}-agent` });
    await caller("human", { client: PERSON }).inboxDecision({ id: dismissed.id, decision: "dismiss" });
    expect((await metadataOf(other))["outcome"]).toBeUndefined();
  });

  it("fails the decision with the refusal, writing nothing, when the session cannot take the outcome", async () => {
    const id = await sessionNode("stopped");
    const filed = await requestHangarOutcome(db, { sessionId: id, outcome: "tabled", note: "Merged.", actor: `${HANGAR}-agent` });
    await db.execute(sql`UPDATE nodes SET metadata = metadata - 'disk_path' || '{"outcome":"accepted"}'::jsonb WHERE id = ${id}::uuid`);
    const refused = await caller("human", { client: PERSON }).inboxDecision({ id: filed.id, decision: "accept", option: "table" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already released") });
    expect(await caller("human").inbox({ statuses: ["pending"] }).then((r) => r.items.find((i) => i.id === filed.id))).toMatchObject({ status: "pending", feedback: [] });
  });
});
