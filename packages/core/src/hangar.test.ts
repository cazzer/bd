// hangar.ts against the real database (hangar-queue spec: "Session requests
// queue until hangar claims them", "Claiming issues a session token",
// "Hangar reports session state", "Hangar status is known from check-ins",
// "Workers receive their messages by long-poll"). The database is shared
// with live data: every fixture is this file's own, every claim names its
// fixtures through `among` so it can never take a real queued request, and
// nothing asserts on a table as a whole. Queued fixtures are requested in
// 2999, so a real hangar claiming oldest first reaches them last, and every
// hangar name starts with `test-`. Cleanup is by id, hangar name, and run
// actor.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientTokens, hangarCheckIns, hangarMessages, nodes, type Database } from "@breakdown/db";
import { sessionTokenClient, verifyClientToken } from "./client-tokens.js";
import { upsertEdges } from "./edges.js";
import {
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidEventTimeError,
  InvalidHangarSessionError,
  NodeNotFoundError,
  NotAWorkItemError,
  ReservedHangarEdgeError,
} from "./errors.js";
import {
  appendHangarMessage,
  assertNoReservedHangarEdges,
  checkHangarTransition,
  claimSession,
  classifyHangarStatus,
  getHangarStatus,
  HANGAR_SESSION_STATES,
  listSessions,
  MAX_CLAIM_CANDIDATES,
  normalizeHangarSessionMetadata,
  readHangarMessages,
  recordCheckIn,
  requestSession,
  requeueSession,
  updateSession,
  type HangarSessionState,
} from "./hangar.js";
import { getNodeHistory } from "./history.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, uniqueSuffix, type TestPool } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
let fixtureRun: IngestRunHandle;
const suffix = uniqueSuffix().slice(0, 12);
const ACTOR_PREFIX = `test-hgt-${suffix}`;
const FIXTURE_SOURCE = `hangar-test-${suffix}`;
const REQUESTER = `${ACTOR_PREFIX}-requester`;
const fixtureNodes: string[] = [];
const sessionIds: string[] = [];
const hangars: string[] = [];
const messageSessions: string[] = [];

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  fixtureRun = await openIngestRun(db, FIXTURE_SOURCE, { actor: ACTOR_PREFIX });
});

afterAll(async () => {
  if (sessionIds.length > 0) await db.delete(clientTokens).where(inArray(clientTokens.sessionId, sessionIds));
  if (messageSessions.length > 0) await db.delete(hangarMessages).where(inArray(hangarMessages.sessionId, messageSessions));
  if (hangars.length > 0) await db.delete(hangarCheckIns).where(inArray(hangarCheckIns.hangar, hangars));
  const ids = [...sessionIds, ...fixtureNodes];
  if (ids.length > 0) await db.delete(nodes).where(inArray(nodes.id, ids));
  await closeIngestRun(db, fixtureRun);
  await db.execute(sql`DELETE FROM ingest_runs WHERE source_system = ${FIXTURE_SOURCE} OR (source_system = 'hangar' AND actor LIKE ${`${ACTOR_PREFIX}%`})`);
  await pool.end();
});

function hangarNamed(label: string): string {
  const name = `${ACTOR_PREFIX}-${label}`;
  hangars.push(name);
  return name;
}

async function fixtureNode(nodeType: string, title: string): Promise<string> {
  const result = await upsertNodes(db, fixtureRun, [{ nodeType, sourceSystem: FIXTURE_SOURCE, externalId: randomUUID(), title, metadata: { status: "open" } }]);
  const id = result.rows[0]!.id;
  fixtureNodes.push(id);
  return id;
}

/** Far in the future, a millisecond apart in request order: oldest-first among fixtures, last behind any real request. */
let requested = 0;
function futureAt(): Date {
  requested += 1;
  return new Date(Date.UTC(2999, 0, 1) + requested);
}

async function request(flavor: string, workItemId?: string) {
  const result = await requestSession(db, { repo: "cazzer/bd", workItemId: workItemId ?? (await fixtureNode("work_item", "Fix the thing")), flavor, actor: REQUESTER, requestedAt: futureAt() });
  sessionIds.push(result.session.id);
  return result.session;
}

async function stateOf(id: string): Promise<Record<string, unknown>> {
  const result = await db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM nodes WHERE id = ${id}::uuid`);
  return result.rows[0]!.metadata;
}

describe("normalizeHangarSessionMetadata", () => {
  const base = { state: "queued", flavor: "headless", repo: "cazzer/bd" };

  it("accepts a minimal session, passing unknown keys through", () => {
    expect(normalizeHangarSessionMetadata({ ...base, extra: { a: 1 } })).toEqual({ ...base, extra: { a: 1 } });
  });

  it("trims text, drops empty and null fields, and canonicalizes claimed_at and occurred_at", () => {
    const out = normalizeHangarSessionMetadata({
      ...base,
      repo: "  cazzer/bd ",
      container: "",
      host: null,
      claimed_by: " hangar-linux ",
      claimed_at: "2026-11-14T10:00:00+01:00",
      occurred_at: "2026-11-14",
    });
    expect(out).toEqual({ ...base, claimed_by: "hangar-linux", claimed_at: "2026-11-14T09:00:00.000Z", occurred_at: "2026-11-14T00:00:00.000Z" });
  });

  it.each([
    [{ ...base, state: "paused" }, "state"],
    [{ ...base, state: undefined }, "state"],
    [{ ...base, flavor: "gpu" }, "flavor"],
    [{ ...base, repo: "" }, "repo"],
    [{ ...base, repo: undefined }, "repo"],
    [{ ...base, repo: "r".repeat(201) }, "repo"],
    [{ ...base, repo: "cazzer/\u0007bd" }, "repo"],
    [{ ...base, repo: 42 }, "repo"],
    [{ ...base, requested_by: "x".repeat(201) }, "requested_by"],
    [{ ...base, claimed_by: "x".repeat(201) }, "claimed_by"],
    [{ ...base, container: "x".repeat(201) }, "container"],
    [{ ...base, host: "x".repeat(201) }, "host"],
    [{ ...base, disk_path: "/".repeat(1025) }, "disk_path"],
    [{ ...base, requeue_reason: "x".repeat(501) }, "requeue_reason"],
    [{ ...base, claimed_at: "yesterday" }, "claimed_at"],
    [{ ...base, claimed_at: 12 }, "claimed_at"],
  ])("refuses %j naming %s", (metadata, field) => {
    const refused = (() => {
      try {
        normalizeHangarSessionMetadata(metadata, { itemLabel: "at batch index 3" });
      } catch (err) {
        return err;
      }
      throw new Error("expected a refusal");
    })();
    expect(refused).toBeInstanceOf(InvalidHangarSessionError);
    expect((refused as InvalidHangarSessionError).field).toBe(field);
    expect((refused as Error).message).toContain("at batch index 3");
  });

  it("accepts the longest allowed disk path and requeue reason", () => {
    const out = normalizeHangarSessionMetadata({ ...base, disk_path: "/".repeat(1024), requeue_reason: "x".repeat(500) });
    expect((out["disk_path"] as string).length).toBe(1024);
  });

  it("refuses a bad occurred_at under the event-time contract", () => {
    expect(() => normalizeHangarSessionMetadata({ ...base, occurred_at: "2026-11-14T10:00:00" })).toThrow(InvalidEventTimeError);
  });

  it("refuses metadata that is not an object", () => {
    expect(() => normalizeHangarSessionMetadata(null)).toThrow(InvalidHangarSessionError);
    expect(() => normalizeHangarSessionMetadata(["queued"])).toThrow(InvalidHangarSessionError);
  });
});

describe("checkHangarTransition", () => {
  const ALLOWED: Record<HangarSessionState, readonly HangarSessionState[]> = {
    queued: ["queued", "running", "stopped", "failed"],
    claimed: ["claimed", "running", "stopped", "failed"],
    running: ["running", "stopped", "failed"],
    stopped: ["stopped"],
    failed: ["failed"],
  };
  const cases = HANGAR_SESSION_STATES.flatMap((from) => HANGAR_SESSION_STATES.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

  it.each(cases)("%s → %s allowed: %s", (from, to, allowed) => {
    if (allowed) {
      expect(() => checkHangarTransition(from, to)).not.toThrow();
      return;
    }
    let refused: unknown;
    try {
      checkHangarTransition(from, to);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(HangarTransitionError);
    expect((refused as Error).message).toContain(JSON.stringify(from));
    expect((refused as Error).message).toContain(JSON.stringify(to));
  });
});

describe("requestSession", () => {
  it("queues a session node with a run_by edge to the work item, under a hangar run naming the requester", async () => {
    const workItemId = await fixtureNode("work_item", "Ship the hangar queue");
    const requestedAt = futureAt();
    const { session, status } = await requestSession(db, { repo: "cazzer/bd", workItemId, flavor: "headless", actor: REQUESTER, requestedAt });
    sessionIds.push(session.id);

    expect(session).toMatchObject({
      sourceSystem: "hangar",
      title: "Hangar headless session: Ship the hangar queue",
      workItemId,
      state: "queued",
      flavor: "headless",
      repo: "cazzer/bd",
      requestedBy: REQUESTER,
      claimedBy: null,
    });
    expect(session.externalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.occurredAt).toBe(requestedAt.toISOString());
    expect(["online", "offline", "never"]).toContain(status.state);
    expect(status.counts.queued).toBeGreaterThanOrEqual(1);

    const stored = await db.execute<{ node_type: string; edge_type: string; dst_id: string; actor: string; run_source: string }>(sql`
      SELECT n.node_type, e.edge_type, e.dst_id, r.actor, r.source_system AS run_source
      FROM nodes n JOIN edges e ON e.src_id = n.id JOIN ingest_runs r ON r.id = n.ingest_run_id
      WHERE n.id = ${session.id}::uuid
    `);
    expect(stored.rows).toEqual([{ node_type: "hangar_session", edge_type: "run_by", dst_id: workItemId, actor: REQUESTER, run_source: "hangar" }]);
  });

  it("stamps requested_at from the database's clock when no test seam names one", async () => {
    const workItemId = await fixtureNode("work_item", "Requested now");
    const before = new Date((await db.execute<{ now: Date }>(sql`SELECT now() AS now`)).rows[0]!.now);
    const { session } = await requestSession(db, { repo: "cazzer/bd", workItemId, flavor: "headless", actor: REQUESTER });
    sessionIds.push(session.id);
    // Claimed at once by this file, so a real hangar has no time to take it.
    await claimSession(db, { hangar: hangarNamed("now-claim"), flavors: ["headless"], among: [session.id] });
    const after = new Date((await db.execute<{ now: Date }>(sql`SELECT now() AS now`)).rows[0]!.now);
    const at = Date.parse(session.occurredAt!);
    expect(at).toBeGreaterThanOrEqual(before.getTime());
    expect(at).toBeLessThanOrEqual(after.getTime());
  });

  it("refuses a node that is not a work item, and a missing one", async () => {
    const note = await fixtureNode("note", "Not a work item");
    await expect(requestSession(db, { repo: "cazzer/bd", workItemId: note, flavor: "headless", actor: REQUESTER })).rejects.toBeInstanceOf(NotAWorkItemError);
    await expect(requestSession(db, { repo: "cazzer/bd", workItemId: randomUUID(), flavor: "headless", actor: REQUESTER })).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("refuses an unknown flavor before opening a run", async () => {
    const workItemId = await fixtureNode("work_item", "Bad flavor");
    const actor = `${ACTOR_PREFIX}-bad-flavor`;
    await expect(requestSession(db, { repo: "cazzer/bd", workItemId, flavor: "gpu", actor })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    const runs = await db.execute(sql`SELECT 1 FROM ingest_runs WHERE actor = ${actor}`);
    expect(runs.rows).toHaveLength(0);
  });
});

describe("claimSession", () => {
  it("takes the oldest queued session of an admitted flavor, leaving the rest queued", async () => {
    const godot = await request("display-godot");
    const headless = await request("headless");
    const laterHeadless = await request("headless");
    const hangar = hangarNamed("claimer");

    const claimed = await claimSession(db, { hangar, flavors: ["headless", "display-browser"], among: [godot.id, headless.id, laterHeadless.id] });
    expect(claimed).not.toBeNull();
    expect(claimed!.session).toMatchObject({ id: headless.id, externalId: headless.externalId, sourceSystem: "hangar", title: headless.title, workItemId: headless.workItemId, state: "claimed", claimedBy: hangar });
    expect(claimed!.session.claimedAt).toMatch(/Z$/);
    expect((await stateOf(godot.id))["state"]).toBe("queued");
    expect((await stateOf(laterHeadless.id))["state"]).toBe("queued");

    const next = await claimSession(db, { hangar, flavors: ["headless"], among: [godot.id, headless.id, laterHeadless.id] });
    expect(next!.session.id).toBe(laterHeadless.id);
    expect(await claimSession(db, { hangar, flavors: ["headless"], among: [godot.id, headless.id, laterHeadless.id] })).toBeNull();
  });

  it("returns a token, shown once, that verifies as the session's agent client", async () => {
    const session = await request("headless");
    const claimed = await claimSession(db, { hangar: hangarNamed("token"), flavors: ["headless"], among: [session.id] });
    expect(claimed!.token).toMatch(/^bdt_[A-Za-z0-9_-]{43}$/);
    expect(await verifyClientToken(db, claimed!.token)).toEqual({ client: `session-${session.id}`, scope: "agent", sessionId: session.id });
  });

  it("hands one queued session to exactly one of two racing claims", async () => {
    const session = await request("headless");
    const results = await Promise.all([
      claimSession(db, { hangar: hangarNamed("race-a"), flavors: ["headless"], among: [session.id] }),
      claimSession(db, { hangar: hangarNamed("race-b"), flavors: ["headless"], among: [session.id] }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const tokens = await db.select().from(clientTokens).where(inArray(clientTokens.sessionId, [session.id]));
    expect(tokens).toHaveLength(1);
  });

  it("counts as a check-in, and a claim that finds nothing opens no run", async () => {
    const hangar = hangarNamed("idle");
    expect(await claimSession(db, { hangar, flavors: ["headless"], among: [] })).toBeNull();
    const status = await getHangarStatus(db, { hangar });
    expect(status).toMatchObject({ state: "online", hangar });
    const runs = await db.execute(sql`SELECT 1 FROM ingest_runs WHERE actor = ${hangar}`);
    expect(runs.rows).toHaveLength(0);
  });

  it("refuses an empty or unknown flavor list", async () => {
    await expect(claimSession(db, { hangar: hangarNamed("flavorless"), flavors: [], among: [] })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(claimSession(db, { hangar: hangarNamed("gpu"), flavors: ["gpu"], among: [] })).rejects.toBeInstanceOf(InvalidHangarSessionError);
  });
});

describe("updateSession and requeueSession", () => {
  async function claimed(label: string) {
    const session = await request("headless");
    const hangar = hangarNamed(label);
    const claim = await claimSession(db, { hangar, flavors: ["headless"], among: [session.id] });
    if (claim === null) throw new Error("fixture claim failed");
    return { session, hangar, token: claim.token };
  }

  it("records running with its placement, then stopped revokes the session token", async () => {
    const { session, hangar, token } = await claimed("runner");
    const running = await updateSession(db, { hangar, id: session.id, state: "running", container: "c-12", host: "hangar-linux", diskPath: `/var/lib/hangar/disks/${session.id}.img` });
    expect(running.session).toMatchObject({ state: "running", container: "c-12", host: "hangar-linux", diskPath: `/var/lib/hangar/disks/${session.id}.img` });
    expect(running.revokedTokens).toBe(0);
    expect(await verifyClientToken(db, token)).not.toBeNull();

    const stopped = await updateSession(db, { hangar, id: session.id, state: "stopped" });
    expect(stopped.session.state).toBe("stopped");
    expect(stopped.revokedTokens).toBe(1);
    expect(await verifyClientToken(db, token)).toBeNull();

    const before = await stateOf(session.id);
    const backwards = await updateSession(db, { hangar, id: session.id, state: "running" }).catch((e: unknown) => e);
    expect(backwards).toBeInstanceOf(HangarTransitionError);
    expect((backwards as Error).message).toContain('"stopped"');
    expect((backwards as Error).message).toContain('"running"');
    expect(await stateOf(session.id)).toEqual(before);
  });

  it("failed revokes the token too, and a field update keeps the state", async () => {
    const { session, hangar, token } = await claimed("failer");
    const moved = await updateSession(db, { hangar, id: session.id, host: "hangar-linux" });
    expect(moved.session).toMatchObject({ state: "claimed", host: "hangar-linux" });
    const cleared = await updateSession(db, { hangar, id: session.id, host: null });
    expect(cleared.session.host).toBeNull();
    const failed = await updateSession(db, { hangar, id: session.id, state: "failed" });
    expect(failed.revokedTokens).toBe(1);
    expect(await verifyClientToken(db, token)).toBeNull();
  });

  it("refuses a hangar that did not claim the session, changing nothing", async () => {
    const { session } = await claimed("owner");
    const before = await stateOf(session.id);
    await expect(updateSession(db, { hangar: hangarNamed("intruder"), id: session.id, state: "running" })).rejects.toBeInstanceOf(HangarSessionNotClaimedByError);
    await expect(requeueSession(db, { hangar: hangarNamed("intruder2"), id: session.id, reason: "mine now" })).rejects.toBeInstanceOf(HangarSessionNotClaimedByError);
    expect(await stateOf(session.id)).toEqual(before);
  });

  it("opens no ingest run for a refused update or requeue: the checks run before the run", async () => {
    const { session, hangar } = await claimed("refused-runs");
    const runsBy = async (actor: string): Promise<number> => (await db.execute(sql`SELECT 1 FROM ingest_runs WHERE actor = ${actor}`)).rows.length;
    const intruder = hangarNamed("refused-intruder");
    await expect(updateSession(db, { hangar: intruder, id: session.id, state: "running" })).rejects.toBeInstanceOf(HangarSessionNotClaimedByError);
    await expect(requeueSession(db, { hangar: intruder, id: session.id, reason: "mine" })).rejects.toBeInstanceOf(HangarSessionNotClaimedByError);
    await expect(updateSession(db, { hangar: intruder, id: randomUUID(), state: "running" })).rejects.toBeInstanceOf(HangarSessionNotFoundError);
    expect(await runsBy(intruder)).toBe(0);

    const claimerRuns = await runsBy(hangar);
    await expect(updateSession(db, { hangar, id: session.id, state: "queued" })).rejects.toBeInstanceOf(HangarTransitionError);
    await updateSession(db, { hangar, id: session.id, state: "running" });
    await expect(requeueSession(db, { hangar, id: session.id, reason: "too late" })).rejects.toBeInstanceOf(HangarTransitionError);
    // Only the accepted update opened one.
    expect(await runsBy(hangar)).toBe(claimerRuns + 1);
  });

  it("refuses a queued session, which no hangar holds, and a node that is not a session", async () => {
    const session = await request("headless");
    await expect(updateSession(db, { hangar: hangarNamed("early"), id: session.id, state: "running" })).rejects.toBeInstanceOf(HangarSessionNotClaimedByError);
    const workItem = await fixtureNode("work_item", "Not a session");
    await expect(updateSession(db, { hangar: hangarNamed("wrong"), id: workItem, state: "running" })).rejects.toBeInstanceOf(HangarSessionNotFoundError);
    await expect(updateSession(db, { hangar: hangarNamed("missing"), id: randomUUID(), state: "running" })).rejects.toBeInstanceOf(HangarSessionNotFoundError);
  });

  it("requeue returns the session with its reason and place in line, revokes its token, and the next claim takes it", async () => {
    const { session, hangar, token } = await claimed("requeuer");
    await updateSession(db, { hangar, id: session.id, host: "hangar-linux" });
    const requeued = await requeueSession(db, { hangar, id: session.id, reason: "disk budget full" });
    expect(requeued.session).toMatchObject({ state: "queued", requeueReason: "disk budget full", claimedBy: null, claimedAt: null, host: null, occurredAt: session.occurredAt });
    expect(requeued.revokedTokens).toBe(1);
    expect(await verifyClientToken(db, token)).toBeNull();

    const again = await claimSession(db, { hangar: hangarNamed("second"), flavors: ["headless"], among: [session.id] });
    expect(again!.session).toMatchObject({ id: session.id, state: "claimed", requeueReason: null, occurredAt: session.occurredAt });
    expect(await verifyClientToken(db, again!.token)).toMatchObject({ sessionId: session.id });
  });

  it("requeue is refused from any state but claimed", async () => {
    const { session, hangar } = await claimed("late-requeue");
    await updateSession(db, { hangar, id: session.id, state: "running" });
    const refused = await requeueSession(db, { hangar, id: session.id, reason: "too late" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HangarTransitionError);
    expect((refused as Error).message).toContain('"running"');
  });

  it("records each change as a revision under a hangar run naming who made it", async () => {
    const { session, hangar } = await claimed("historian");
    await updateSession(db, { hangar, id: session.id, state: "running", container: "c-1" });
    await updateSession(db, { hangar, id: session.id, state: "stopped" });
    const history = await getNodeHistory(db, session.id);
    const oldestFirst = [...history.revisions].reverse();
    expect(oldestFirst.map((r) => r.metadata["state"])).toEqual(["queued", "claimed", "running", "stopped"]);
    expect(oldestFirst.map((r) => r.ingestRun.actor)).toEqual([REQUESTER, hangar, hangar, hangar]);
    for (const revision of oldestFirst) expect(revision.ingestRun.sourceSystem).toBe("hangar");
  });
});

describe("listSessions", () => {
  it("filters by claimer, state, and work item, newest change first, with truncation", async () => {
    const workItemId = await fixtureNode("work_item", "Listed");
    const a = await request("headless", workItemId);
    const b = await request("headless", workItemId);
    const c = await request("display-browser", workItemId);
    const hangar = hangarNamed("lister");
    await claimSession(db, { hangar, flavors: ["headless"], among: [a.id] });
    await claimSession(db, { hangar, flavors: ["headless"], among: [b.id] });
    await updateSession(db, { hangar, id: a.id, state: "running" });

    const mine = await listSessions(db, { claimedBy: hangar });
    expect(mine.sessions.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(mine.truncated).toBe(false);

    expect((await listSessions(db, { claimedBy: hangar, states: ["running"] })).sessions.map((s) => s.id)).toEqual([a.id]);
    const forItem = await listSessions(db, { workItemId });
    expect(forItem.sessions.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
    expect(forItem.sessions.every((s) => s.workItemId === workItemId)).toBe(true);

    const page = await listSessions(db, { workItemId, limit: 2 });
    expect(page.sessions).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect((await listSessions(db, { workItemId, states: [] })).sessions).toEqual([]);
  });

  it("refuses a limit out of range and an unknown state", async () => {
    await expect(listSessions(db, { limit: 0 })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(listSessions(db, { limit: 201 })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(listSessions(db, { states: ["paused"] })).rejects.toBeInstanceOf(InvalidHangarSessionError);
  });
});

describe("check-ins and status", () => {
  it("records a check-in and reports that hangar online with its version and interval", async () => {
    const hangar = hangarNamed("checker");
    expect(await recordCheckIn(db, { hangar, version: "0.3.0", capacity: { slots: 2 } })).toEqual({ intervalS: 30, now: expect.any(Date) });
    const second = await recordCheckIn(db, { hangar, version: "0.3.1" });
    expect(second.intervalS).toBe(30);
    const rows = await db.select().from(hangarCheckIns).where(inArray(hangarCheckIns.hangar, [hangar]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: "0.3.1", capacity: null });
    // `now` is the database's own: the time it recorded the check-in at.
    expect(second.now.getTime()).toBe(new Date(rows[0]!.lastSeenAt).getTime());

    const status = await getHangarStatus(db, { hangar });
    expect(status).toMatchObject({ state: "online", hangar, version: "0.3.1", intervalS: 30 });
    expect(status.now.getTime() - status.lastSeenAt!.getTime()).toBeLessThan(60_000);
  });

  it("reports never for a hangar that has not checked in", async () => {
    expect(await getHangarStatus(db, { hangar: `${ACTOR_PREFIX}-ghost` })).toMatchObject({ state: "never", lastSeenAt: null, hangar: null });
  });

  it("reports offline since the last check-in once it is older than three intervals", async () => {
    const hangar = hangarNamed("gone");
    await recordCheckIn(db, { hangar });
    await db.execute(sql`UPDATE hangar_check_ins SET last_seen_at = now() - interval '2 hours' WHERE hangar = ${hangar}`);
    const status = await getHangarStatus(db, { hangar });
    expect(status.state).toBe("offline");
    expect(Math.round((status.now.getTime() - status.lastSeenAt!.getTime()) / 60_000)).toBe(120);
  });

  it("classifyHangarStatus: online under 90 s at the default interval, offline at 90 s, never with no row", () => {
    const lastSeenAt = new Date("2026-11-14T09:00:00.000Z");
    const at = (ms: number) => new Date(lastSeenAt.getTime() + ms);
    expect(classifyHangarStatus({ lastSeenAt, intervalS: 30 }, at(89_999))).toEqual({ state: "online", lastSeenAt });
    expect(classifyHangarStatus({ lastSeenAt, intervalS: 30 }, at(90_000))).toEqual({ state: "offline", lastSeenAt });
    expect(classifyHangarStatus({ lastSeenAt, intervalS: 30 }, at(2 * 60 * 60_000))).toEqual({ state: "offline", lastSeenAt });
    expect(classifyHangarStatus({ lastSeenAt, intervalS: 10 }, at(30_000))).toEqual({ state: "offline", lastSeenAt });
    expect(classifyHangarStatus(null, at(0))).toEqual({ state: "never", lastSeenAt: null });
  });

  it("refuses a capacity that is not an object", async () => {
    await expect(recordCheckIn(db, { hangar: hangarNamed("bad-capacity"), capacity: [1] as unknown as Record<string, unknown> })).rejects.toBeInstanceOf(InvalidHangarSessionError);
  });
});

describe("messages", () => {
  function sessionForMessages(): string {
    const id = randomUUID();
    messageSessions.push(id);
    return id;
  }

  it("reads after a cursor, oldest first, up to a limit, and only the named session's", async () => {
    const mine = sessionForMessages();
    const theirs = sessionForMessages();
    const ids: number[] = [];
    for (let n = 1; n <= 3; n += 1) ids.push((await db.transaction((tx) => appendHangarMessage(tx, { sessionId: mine, kind: "inbox_decision", body: { n } }))).id);
    await db.transaction((tx) => appendHangarMessage(tx, { sessionId: theirs, kind: "inbox_decision", body: { n: 99 } }));

    const all = await readHangarMessages(db, { sessionId: mine });
    expect(all.messages.map((m) => m.body)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(all.messages.map((m) => m.id)).toEqual(ids);
    expect(all.cursor).toBe(ids[2]);

    const page = await readHangarMessages(db, { sessionId: mine, after: ids[0], limit: 1 });
    expect(page.messages.map((m) => m.id)).toEqual([ids[1]]);
    expect(page.cursor).toBe(ids[1]);
    const empty = await readHangarMessages(db, { sessionId: mine, after: ids[2] });
    expect(empty).toEqual({ messages: [], cursor: ids[2] });

    expect((await readHangarMessages(db, { sessionId: theirs })).messages.map((m) => m.body)).toEqual([{ n: 99 }]);
  });

  it("refuses an out-of-range limit or cursor", async () => {
    const id = sessionForMessages();
    await expect(readHangarMessages(db, { sessionId: id, limit: 51 })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(readHangarMessages(db, { sessionId: id, after: -1 })).rejects.toBeInstanceOf(InvalidHangarSessionError);
  });

  it("serializes concurrent appends so a cursor read never skips an id", async () => {
    const id = sessionForMessages();
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstAppended!: () => void;
    const appended = new Promise<void>((resolve) => (firstAppended = resolve));

    const first = db.transaction(async (tx) => {
      const row = await appendHangarMessage(tx, { sessionId: id, kind: "test", body: { n: 1 } });
      firstAppended();
      await held;
      return row;
    });
    await appended;
    let secondDone = false;
    const second = db
      .transaction((tx) => appendHangarMessage(tx, { sessionId: id, kind: "test", body: { n: 2 } }))
      .then((row) => {
        secondDone = true;
        return row;
      });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondDone).toBe(false);
    expect((await readHangarMessages(db, { sessionId: id })).messages).toEqual([]);

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(b.id).toBeGreaterThan(a.id);
    const read = await readHangarMessages(db, { sessionId: id });
    expect(read.messages.map((m) => [m.id, m.body])).toEqual([
      [a.id, { n: 1 }],
      [b.id, { n: 2 }],
    ]);
  });
});

// hangar-queue security review: a row at the head of the queue that cannot
// be claimed must not fail every claim behind it, and a session's work item
// is only ever the one the queue linked.
describe("claimSession passes over a session it cannot claim", () => {
  async function corrupt(id: string): Promise<void> {
    await db.execute(sql`UPDATE nodes SET metadata = jsonb_set(metadata, '{repo}', '42'::jsonb) WHERE id = ${id}::uuid`);
  }

  it("marks a session whose metadata breaks the contract failed with a reason, and claims the next", async () => {
    const broken = await request("headless");
    const good = await request("headless");
    await corrupt(broken.id);
    const claimed = await claimSession(db, { hangar: hangarNamed("past-broken"), flavors: ["headless"], among: [broken.id, good.id] });
    expect(claimed!.session.id).toBe(good.id);
    const failed = await stateOf(broken.id);
    expect(failed["state"]).toBe("failed");
    expect(failed["failure_reason"]).toMatch(/breaks the session contract.*repo/);
  });

  it("marks at most MAX_CLAIM_CANDIDATES per attempt, and the next attempt goes on", async () => {
    const broken = [];
    for (let i = 0; i <= MAX_CLAIM_CANDIDATES; i += 1) broken.push(await request("headless"));
    const good = await request("headless");
    for (const b of broken) await corrupt(b.id);
    const among = [...broken.map((b) => b.id), good.id];
    const hangar = hangarNamed("bounded");
    expect(await claimSession(db, { hangar, flavors: ["headless"], among })).toBeNull();
    const states = await Promise.all(broken.map(async (b) => (await stateOf(b.id))["state"]));
    expect(states.filter((st) => st === "failed")).toHaveLength(MAX_CLAIM_CANDIDATES);
    const next = await claimSession(db, { hangar, flavors: ["headless"], among });
    expect(next!.session.id).toBe(good.id);
  });

  it("marks a session whose token name a live token already holds failed, minting nothing, and claims the next", async () => {
    const squatted = await request("headless");
    const good = await request("headless");
    const client = sessionTokenClient(squatted.id);
    await db.insert(clientTokens).values({ client, scope: "agent", tokenHash: Buffer.from(randomUUID()) });
    try {
      const claimed = await claimSession(db, { hangar: hangarNamed("past-squat"), flavors: ["headless"], among: [squatted.id, good.id] });
      expect(claimed!.session.id).toBe(good.id);
      const failed = await stateOf(squatted.id);
      expect(failed).toMatchObject({ state: "failed", failure_reason: expect.stringContaining(client) });
      expect(failed).not.toHaveProperty("claimed_by");
      const minted = await db.select().from(clientTokens).where(inArray(clientTokens.sessionId, [squatted.id]));
      expect(minted).toHaveLength(0);
    } finally {
      await db.delete(clientTokens).where(inArray(clientTokens.client, [client]));
    }
  });
});

describe("run_by integrity", () => {
  it("counts only the queue's own run_by edge: an agent's edge out of a session names no work item", async () => {
    const session = await request("headless");
    const other = await fixtureNode("work_item", "Other work");
    await db.execute(sql`DELETE FROM edges WHERE src_id = ${session.id}::uuid AND edge_type = 'run_by'`);
    await upsertEdges(db, fixtureRun, [{ srcId: session.id, dstId: other, edgeType: "run_by", sourceSystem: FIXTURE_SOURCE, weight: 1 }]);
    const [listed] = (await listSessions(db, { states: ["queued"], workItemId: session.workItemId! })).sessions.filter((x) => x.id === session.id);
    expect(listed).toBeUndefined();
    expect((await listSessions(db, { workItemId: other })).sessions.map((x) => x.id)).not.toContain(session.id);
  });

  it("assertNoReservedHangarEdges refuses source system hangar and any edge out of a session, and allows one into it", async () => {
    const session = await request("headless");
    const work = await fixtureNode("work_item", "Some work");
    await expect(assertNoReservedHangarEdges(db, [{ srcId: work, sourceSystem: "hangar" }])).rejects.toBeInstanceOf(ReservedHangarEdgeError);
    const refused = await assertNoReservedHangarEdges(db, [{ srcId: work, sourceSystem: "agent" }, { srcId: session.id.toUpperCase(), sourceSystem: "agent" }]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ReservedHangarEdgeError);
    expect((refused as Error).message).toContain("batch index 1");
    await expect(assertNoReservedHangarEdges(db, [{ srcId: work, sourceSystem: "agent" }])).resolves.toBeUndefined();
  });
});
