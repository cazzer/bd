// `hangarStatus` over the real router and database (hangar-queue design
// decision 7). The database is shared with live data and with suites that
// check hangar in in parallel, so this asserts the shape and the rules that
// hold whichever hangar checked in last, never a particular liveness state.
// `hangarSessionOutcome` and an outcome request's inbox decision
// (hangar-release) run on this file's own session nodes, written straight to
// the store and never queued, so no real hangar can claim them.
// `hangarSessions` lists sessions requested for this file's own work item,
// queued far in the future so an oldest-first claim reaches them last.

import { randomUUID } from "node:crypto";
import { closeIngestRun, HANGAR_WAIT_KINDS, openIngestRun, recordCheckIn, requestHangarOutcome, requestSession, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, hangarCheckIns, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";
import { HANGAR_SESSION_RELEASED_MESSAGE, hangarSessionNotEndedMessage } from "../errors.js";

const HANGAR = `test-hgstatus-${randomUUID().slice(0, 8)}`;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const PERSON = `${HANGAR}-person`;
const SESSION_NODES: string[] = [];
const WORK_ITEMS: string[] = [];

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
  if (WORK_ITEMS.length > 0) {
    const sessions = await db.execute<{ id: string }>(sql`SELECT src_id AS id FROM edges WHERE edge_type = 'run_by' AND dst_id = ANY(${`{${WORK_ITEMS.join(",")}}`}::uuid[])`);
    SESSION_NODES.push(...sessions.rows.map((r) => r.id));
  }
  if (SESSION_NODES.length > 0) {
    await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), inArray(nodes.externalId, SESSION_NODES.map((id) => `hangar-outcome:${id}`))));
    await db.delete(nodes).where(inArray(nodes.id, SESSION_NODES));
  }
  if (WORK_ITEMS.length > 0) await db.delete(nodes).where(inArray(nodes.id, WORK_ITEMS));
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
    expect(Object.keys(status).sort()).toEqual(["capacity", "capacityAt", "claimed", "hangar", "intervalS", "lastSeenAt", "now", "queued", "running", "status", "version"]);
    // A check-in just landed, so some hangar has checked in recently.
    expect(status.status).toBe("online");
    expect(status.hangar).toEqual(expect.any(String));
    expect(status.lastSeenAt).toMatch(ISO);
    expect(status.now).toMatch(ISO);
    expect(Date.parse(status.now)).toBeGreaterThanOrEqual(Date.parse(status.lastSeenAt!));
    expect(status.intervalS).toBe(30);
    for (const n of [status.queued, status.claimed, status.running]) expect(Number.isInteger(n) && n >= 0).toBe(true);
    // Whichever hangar checked in last, a capacity comes with its time and none without.
    expect(status.capacity === null).toBe(status.capacityAt === null);
    if (status.capacityAt !== null) expect(status.capacityAt).toMatch(ISO);
  });

  it("answers the capacity hangar reported, with its time, when ours checked in last", async () => {
    await recordCheckIn(db, { hangar: HANGAR, version: "9.9.9", capacity: { slots: { headless: 1 }, blocked: { "display-browser": "ram: need 4096 MB, free 1200 MB" } } });
    const status = await caller("agent").hangarStatus();
    if (status.hangar === HANGAR) {
      expect(status.capacity).toEqual({ slots: { headless: 1 }, blocked: { "display-browser": "ram: need 4096 MB, free 1200 MB" } });
      expect(status.capacityAt).toMatch(ISO);
    }
    await recordCheckIn(db, { hangar: HANGAR, version: "9.9.9", capacity: null });
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
    // Worded for the person on the board row, not the core message's ids.
    expect(refused).toMatchObject({ code: "CONFLICT", message: hangarSessionNotEndedMessage("running") });
    expect((refused as Error).message).toBe("Only a stopped or failed session can be accepted or tabled (this one is running).");
  });

  it("refuses a released session with CONFLICT in the person's words", async () => {
    const id = await sessionNode("stopped");
    await caller("human", { client: PERSON }).hangarSessionOutcome({ id, outcome: "tabled" });
    await db.execute(sql`UPDATE nodes SET metadata = metadata - 'disk_path' WHERE id = ${id}::uuid`);
    const refused = await caller("human").hangarSessionOutcome({ id, outcome: "accepted" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "CONFLICT", message: HANGAR_SESSION_RELEASED_MESSAGE });
    expect(HANGAR_SESSION_RELEASED_MESSAGE).toBe("This session is already released: hangar has removed its disk, so the outcome can't change.");
  });
});

describe("hangarSessions", () => {
  it("lists a work item's sessions newest-changed first, with the outcome and whether a disk is held", async () => {
    const item = await upsertNodes(db, run, [{ nodeType: "work_item", sourceSystem: `${HANGAR}-fixtures`, externalId: randomUUID(), title: "Sessions fixture", metadata: { status: "open", priority: 2 } }]);
    const workItemId = item.rows[0]!.id;
    WORK_ITEMS.push(workItemId);
    expect(await caller("human").hangarSessions({ workItemId })).toEqual({ sessions: [], truncated: false });

    const later = new Date("2999-01-01T00:00:00.000Z");
    const first = (await requestSession(db, { repo: "test/repo", workItemId, flavor: "headless", actor: PERSON, requestedAt: later })).session;
    const second = (await requestSession(db, { repo: "test/repo", workItemId, flavor: "display-browser", actor: PERSON, requestedAt: later })).session;
    // Ended and holding a disk, as hangar would leave it, written straight to the store.
    await upsertNodes(db, run, [
      { nodeType: "hangar_session", sourceSystem: "hangar", externalId: first.externalId, title: first.title, metadata: { state: "failed", flavor: "headless", repo: "test/repo", claimed_by: HANGAR, container: "c-1", host: "h-1", disk_path: "/disks/t.img", failure_reason: "worker exited 3" } },
    ]);
    await caller("human", { client: PERSON }).hangarSessionOutcome({ id: first.id, outcome: "tabled" });

    const listed = await caller(null, { readOnly: true }).hangarSessions({ workItemId });
    expect(listed.truncated).toBe(false);
    expect(listed.sessions.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(listed.sessions[0]).toMatchObject({ state: "failed", flavor: "headless", outcome: "tabled", outcomeBy: PERSON, released: false, diskHeld: true, container: "c-1", host: "h-1", failureReason: "worker exited 3" });
    expect(listed.sessions[0]!.updatedAt).toMatch(ISO);
    expect(listed.sessions[1]).toMatchObject({ state: "queued", flavor: "display-browser", outcome: null, outcomeAt: null, released: false, diskHeld: false, container: null, requestedAt: later.toISOString() });
    expect(Object.keys(listed.sessions[0]!)).not.toContain("diskPath");
    // Why the queued one waits depends on every hangar checked in, so only its shape is ours to assert.
    expect(listed.sessions[0]!.waiting).toBeNull();
    const waiting = listed.sessions[1]!.waiting;
    expect(waiting).not.toBeNull();
    expect(HANGAR_WAIT_KINDS).toContain(waiting!.kind);
    expect(waiting!.text).toEqual(expect.any(String));
  });

  it("refuses an agent token and a malformed id", async () => {
    expect(await caller("agent").hangarSessions({ workItemId: randomUUID() }).catch((e: unknown) => e)).toMatchObject({ code: "FORBIDDEN" });
    expect(await caller("human").hangarSessions({ workItemId: "nope" }).catch((e: unknown) => e)).toMatchObject({ code: "BAD_REQUEST" });
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
    expect(refused).toMatchObject({ code: "CONFLICT", message: HANGAR_SESSION_RELEASED_MESSAGE });
    expect(await caller("human").inbox({ statuses: ["pending"] }).then((r) => r.items.find((i) => i.id === filed.id))).toMatchObject({ status: "pending", feedback: [] });
  });

  it("serves the bound session's facts on the inbox item for the card's banner; other items carry none", async () => {
    const id = await sessionNode("failed");
    const filed = await requestHangarOutcome(db, { sessionId: id, outcome: "tabled", note: "Merged.", actor: `${HANGAR}-agent` });
    const items = (await caller("human").inbox({ statuses: ["pending"] })).items;
    const bound = items.find((i) => i.id === filed.id);
    expect(bound).toMatchObject({ hangarOutcome: { sessionId: id, requested: "tabled" }, hangarOutcomeSession: { id, state: "failed", repo: "test/repo", diskHeld: true, released: false } });
    expect(Object.keys(bound!.hangarOutcomeSession!)).not.toContain("diskPath");
    expect(items.filter((i) => i.hangarOutcome === null).every((i) => i.hangarOutcomeSession === null)).toBe(true);
  });

  it("inboxRequest refuses a hangar-outcome: key with FORBIDDEN, writing nothing", async () => {
    const id = await sessionNode("stopped");
    const key = `hangar-outcome:${id}`;
    const refused = await caller("agent", { client: `${HANGAR}-agent` })
      .inboxRequest({ key, title: "Accept", content: "Safe to click.", metadata: { source: "hangar", question: "Accept?", options: [{ id: "accept", label: "Accept" }, { id: "table", label: "Table" }] } })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.sourceSystem, "inbox"), eq(nodes.externalId, key)))).toEqual([]);
  });
});
