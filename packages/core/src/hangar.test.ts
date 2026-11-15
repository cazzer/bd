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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clientTokens, hangarCheckIns, hangarMessages, nodes, type Database } from "@breakdown/db";
import { sessionTokenClient, verifyClientToken } from "./client-tokens.js";
import { upsertEdges } from "./edges.js";
import {
  HangarEndedSessionChangeError,
  HangarOutcomeRefusedError,
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidEventTimeError,
  InvalidHangarSessionError,
  InvalidLookupIdError,
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
  classifyQueuedWait,
  explainQueuedSessions,
  getHangarStatus,
  HANGAR_SESSION_STATES,
  listSessions,
  MAX_CLAIM_CANDIDATES,
  MAX_HANGAR_AWAITING_REVIEW_LISTED,
  MAX_HANGAR_CAPACITY_CHARS,
  MAX_HANGAR_SESSIONS_LIMIT,
  MAX_HANGAR_USAGE_ENTRIES,
  normalizeHangarSessionMetadata,
  parseHangarCapacity,
  readHangarMessages,
  recordCheckIn,
  requestSession,
  requeueSession,
  setHangarSessionOutcome,
  updateSession,
  type HangarCheckInSnapshot,
  type HangarSessionState,
  type QueuedWaitContext,
} from "./hangar.js";
import { getNodeHistory } from "./history.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { DEFAULT_MAX_METADATA_LENGTH, upsertNodes } from "./nodes.js";
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

/** A session claimed by a fresh hangar, moved to `state` with a disk (unless `state` is claimed). */
async function ended(label: string, state: HangarSessionState, workItemId?: string) {
  const session = await request("headless", workItemId);
  const hangar = hangarNamed(label);
  if ((await claimSession(db, { hangar, flavors: ["headless"], among: [session.id] })) === null) throw new Error("fixture claim failed");
  await updateSession(db, { hangar, id: session.id, state: "running", container: `hangar-${session.id}`, diskPath: `/disks/${session.id}.img` });
  if (state !== "running") await updateSession(db, { hangar, id: session.id, state });
  return { id: session.id, hangar };
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
    [{ ...base, outcome: "shelved" }, "outcome"],
    [{ ...base, outcome: true }, "outcome"],
    [{ ...base, outcome_at: "later" }, "outcome_at"],
    [{ ...base, outcome_by: "x".repeat(201) }, "outcome_by"],
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

  it("keeps a known outcome with its time and author, and drops a null or empty one", () => {
    const out = normalizeHangarSessionMetadata({ ...base, state: "stopped", outcome: "tabled", outcome_at: "2026-11-14T10:00:00+01:00", outcome_by: " phone " });
    expect(out).toEqual({ ...base, state: "stopped", outcome: "tabled", outcome_at: "2026-11-14T09:00:00.000Z", outcome_by: "phone" });
    expect(normalizeHangarSessionMetadata({ ...base, outcome: null })).toEqual(base);
    expect(normalizeHangarSessionMetadata({ ...base, outcome: "" })).toEqual(base);
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
    expect(rows[0]).toMatchObject({ version: "0.3.1", capacity: null, capacityAt: null });
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

  it("fails an oversized session, dropping the offending fields so the failure writes, and claims the next", async () => {
    const oversized = await request("headless");
    const good = await request("headless");
    // Unknown keys pass the contract, so only the node write's own limit stops this row: the
    // oversized key is dropped, and a small one kept.
    await db.execute(sql`
      UPDATE nodes SET metadata = metadata || jsonb_build_object('notes', ${"x".repeat(DEFAULT_MAX_METADATA_LENGTH)}::text, 'tag', 'keep-me')
      WHERE id = ${oversized.id}::uuid
    `);
    const hangar = hangarNamed("past-oversized");
    const claimed = await claimSession(db, { hangar, flavors: ["headless"], among: [oversized.id, good.id] });
    expect(claimed!.session.id).toBe(good.id);
    const failed = await stateOf(oversized.id);
    expect(failed).toMatchObject({ state: "failed", flavor: "headless", repo: "cazzer/bd", tag: "keep-me", failure_reason: expect.stringMatching(/past the node limits/) });
    expect(failed).not.toHaveProperty("notes");
    expect(JSON.stringify(failed).length).toBeLessThanOrEqual(DEFAULT_MAX_METADATA_LENGTH);
    // Failed is final: a later claim passes over it.
    expect(await claimSession(db, { hangar, flavors: ["headless"], among: [oversized.id] })).toBeNull();
  });

  it("fails a contract-breaking session that is also oversized, rather than aborting the claim", async () => {
    const broken = await request("headless");
    const good = await request("headless");
    await db.execute(sql`
      UPDATE nodes SET metadata = metadata || jsonb_build_object('repo', 42, 'host', ${"h".repeat(10_000)}::text, 'notes', ${"x".repeat(DEFAULT_MAX_METADATA_LENGTH)}::text)
      WHERE id = ${broken.id}::uuid
    `);
    const claimed = await claimSession(db, { hangar: hangarNamed("past-broken-oversized"), flavors: ["headless"], among: [broken.id, good.id] });
    expect(claimed!.session.id).toBe(good.id);
    const failed = await stateOf(broken.id);
    expect(failed).toMatchObject({ state: "failed", failure_reason: expect.stringMatching(/breaks the session contract.*repo/) });
    expect(failed).toMatchObject({ flavor: "headless" });
    for (const dropped of ["repo", "host", "notes"]) expect(failed).not.toHaveProperty(dropped);
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

describe("a person's outcome and hangar's release", () => {
  const PERSON = `${ACTOR_PREFIX}-person`;
  const runsBy = async (actor: string): Promise<number> => (await db.execute(sql`SELECT 1 FROM ingest_runs WHERE actor = ${actor}`)).rows.length;

  it("sets an outcome on a stopped session, attributed to the person, as a revision that moves it to the front of hangar's listing", async () => {
    const first = await ended("front", "stopped");
    const second = await request("headless");
    if ((await claimSession(db, { hangar: first.hangar, flavors: ["headless"], among: [second.id] })) === null) throw new Error("fixture claim failed");
    await updateSession(db, { hangar: first.hangar, id: second.id, state: "stopped" });
    expect((await listSessions(db, { claimedBy: first.hangar, states: ["stopped", "failed"] })).sessions.map((s) => s.id)).toEqual([second.id, first.id]);

    const before = (await listSessions(db, { claimedBy: first.hangar, states: ["stopped"] })).sessions.find((s) => s.id === first.id)!;
    const set = await setHangarSessionOutcome(db, { id: first.id, outcome: "tabled", actor: PERSON });
    expect(set.changed).toBe(true);
    expect(set.session).toMatchObject({ id: first.id, state: "stopped", outcome: "tabled", outcomeBy: PERSON, released: false, diskPath: `/disks/${first.id}.img` });
    expect(set.session.outcomeAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(set.session.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await listSessions(db, { claimedBy: first.hangar, states: ["stopped", "failed"] })).sessions.map((s) => s.id)).toEqual([first.id, second.id]);

    const [latest] = (await getNodeHistory(db, first.id)).revisions;
    expect(latest!.metadata).toMatchObject({ state: "stopped", outcome: "tabled", outcome_by: PERSON });
    expect(latest!.ingestRun).toMatchObject({ actor: PERSON, sourceSystem: "hangar" });
  });

  it("sets one on a failed session", async () => {
    const { id } = await ended("failed", "failed");
    expect((await setHangarSessionOutcome(db, { id, outcome: "accepted", actor: PERSON })).session).toMatchObject({ state: "failed", outcome: "accepted" });
  });

  it.each(["queued", "claimed", "running"] as const)("refuses a %s session naming its state, writing nothing and opening no run", async (state) => {
    let id: string;
    if (state === "queued") id = (await request("headless")).id;
    else if (state === "claimed") {
      id = (await request("headless")).id;
      await claimSession(db, { hangar: hangarNamed(`open-${state}`), flavors: ["headless"], among: [id] });
    } else id = (await ended(`open-${state}`, "running")).id;
    const actor = `${PERSON}-${state}`;
    const before = await stateOf(id);
    const refused = await setHangarSessionOutcome(db, { id, outcome: "accepted", actor }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HangarOutcomeRefusedError);
    expect((refused as Error).message).toContain(`is ${state}`);
    expect(await stateOf(id)).toEqual(before);
    expect(await runsBy(actor)).toBe(0);
  });

  it("refuses an unknown outcome and a node that is not a session", async () => {
    const { id } = await ended("unknown", "stopped");
    await expect(setHangarSessionOutcome(db, { id, outcome: "shelved", actor: PERSON })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(setHangarSessionOutcome(db, { id: await fixtureNode("work_item", "Not a session"), outcome: "tabled", actor: PERSON })).rejects.toBeInstanceOf(HangarSessionNotFoundError);
  });

  it("is a no-op for the outcome it already has, and can change until hangar releases it", async () => {
    const { id, hangar } = await ended("change", "stopped");
    await setHangarSessionOutcome(db, { id, outcome: "accepted", actor: PERSON });
    const revisions = (await getNodeHistory(db, id)).revisions.length;
    const again = await setHangarSessionOutcome(db, { id, outcome: "accepted", actor: `${PERSON}-again` });
    expect(again.changed).toBe(false);
    expect(again.session.outcomeBy).toBe(PERSON);
    expect((await getNodeHistory(db, id)).revisions).toHaveLength(revisions);
    expect(await runsBy(`${PERSON}-again`)).toBe(0);

    expect((await setHangarSessionOutcome(db, { id, outcome: "tabled", actor: PERSON })).session.outcome).toBe("tabled");

    // Hangar releases it: the ack clears the placement and keeps the outcome.
    const acked = await updateSession(db, { hangar, id, container: null, diskPath: null });
    expect(acked.session).toMatchObject({ state: "stopped", outcome: "tabled", container: null, diskPath: null, released: true });
    const refused = await setHangarSessionOutcome(db, { id, outcome: "accepted", actor: PERSON }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HangarOutcomeRefusedError);
    expect((refused as Error).message).toContain("already released");
    expect((await setHangarSessionOutcome(db, { id, outcome: "tabled", actor: PERSON })).changed).toBe(false);
  });

  it("stores hangar's failure reason, taken only with failed", async () => {
    const { id, hangar } = await ended("reason", "running");
    await expect(updateSession(db, { hangar, id, state: "stopped", reason: "worker exited 3" })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(updateSession(db, { hangar, id, reason: "worker exited 3" })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    await expect(updateSession(db, { hangar, id, state: "failed", reason: "x".repeat(501) })).rejects.toBeInstanceOf(InvalidHangarSessionError);
    expect((await stateOf(id))["state"]).toBe("running");
    const failed = await updateSession(db, { hangar, id, state: "failed", reason: "  git clone exited 128 " });
    expect(failed.session).toMatchObject({ state: "failed", failureReason: "git clone exited 128" });
  });

  it("an ended session's container and disk_path only clear; a set value is refused, changing nothing", async () => {
    const { id, hangar } = await ended("only-clear", "stopped");
    const before = await stateOf(id);
    for (const change of [{ diskPath: "/disks/other.img" }, { container: "c-new" }, { state: "stopped", diskPath: "/disks/other.img" }]) {
      const refused = await updateSession(db, { hangar, id, ...change }).catch((e: unknown) => e);
      expect(refused, JSON.stringify(change)).toBeInstanceOf(HangarEndedSessionChangeError);
      expect((refused as HangarEndedSessionChangeError).kind).toBe("value");
    }
    expect(await stateOf(id)).toEqual(before);
    // Its own value again is no change: a retried report is not refused.
    expect((await updateSession(db, { hangar, id, state: "stopped", container: `hangar-${id}` })).session.container).toBe(`hangar-${id}`);
    // A host is still hangar's to report.
    expect((await updateSession(db, { hangar, id, host: "hangar-linux" })).session.host).toBe("hangar-linux");
  });

  it("refuses the ack (clearing a held disk_path) unless an outcome is set", async () => {
    const { id, hangar } = await ended("ack-first", "failed");
    const refused = await updateSession(db, { hangar, id, container: null, diskPath: "" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HangarEndedSessionChangeError);
    expect((refused as HangarEndedSessionChangeError).kind).toBe("no_outcome");
    expect(await stateOf(id)).toMatchObject({ container: `hangar-${id}`, disk_path: `/disks/${id}.img` });
    await setHangarSessionOutcome(db, { id, outcome: "tabled", actor: PERSON });
    expect((await updateSession(db, { hangar, id, container: null, diskPath: null })).session.released).toBe(true);
  });

  it("refuses any change but a clear on a released session: it is never un-released", async () => {
    const { id, hangar } = await ended("unrelease", "stopped");
    await setHangarSessionOutcome(db, { id, outcome: "accepted", actor: PERSON });
    await updateSession(db, { hangar, id, diskPath: null });
    for (const change of [{ diskPath: `/disks/${id}.img` }, { container: "c-new" }, { host: "elsewhere" }]) {
      const refused = await updateSession(db, { hangar, id, ...change }).catch((e: unknown) => e);
      expect(refused, JSON.stringify(change)).toBeInstanceOf(HangarEndedSessionChangeError);
      expect((refused as HangarEndedSessionChangeError).kind).toBe("released");
    }
    expect((await setHangarSessionOutcome(db, { id, outcome: "tabled", actor: PERSON }).catch((e: unknown) => e))).toBeInstanceOf(HangarOutcomeRefusedError);
    // The ack, and its repeat after a lost answer, still answer.
    for (let i = 0; i < 2; i += 1) expect((await updateSession(db, { hangar, id, container: null, diskPath: null })).session).toMatchObject({ released: true, container: null, outcome: "accepted" });
  });

  it("does not overwrite failure_reason on a repeated failed report", async () => {
    const { id, hangar } = await ended("refail", "running");
    await updateSession(db, { hangar, id, state: "failed", reason: "worker exited 3" });
    const again = await updateSession(db, { hangar, id, state: "failed", reason: "hangar lost the worker while it was down" });
    expect(again.session).toMatchObject({ state: "failed", failureReason: "worker exited 3" });
  });

  it("lists releasable sessions: an outcome set and the disk still held", async () => {
    const workItemId = await fixtureNode("work_item", "Releasable");
    const decided = await ended("rel-decided", "stopped", workItemId);
    const released = await ended("rel-released", "failed", workItemId);
    const undecided = await ended("rel-undecided", "stopped", workItemId);
    await setHangarSessionOutcome(db, { id: decided.id, outcome: "tabled", actor: PERSON });
    await setHangarSessionOutcome(db, { id: released.id, outcome: "accepted", actor: PERSON });
    await updateSession(db, { hangar: released.hangar, id: released.id, container: null, diskPath: null });
    expect((await listSessions(db, { workItemId, releasable: true })).sessions.map((s) => s.id)).toEqual([decided.id]);
    expect((await listSessions(db, { workItemId })).sessions.map((s) => s.id).sort()).toEqual([decided.id, released.id, undecided.id].sort());
  });
});

// hangar-capacity spec: "Hangar reports capacity and per-session usage", "A
// queued request says why it waits". Slots here name only headless and
// display-browser, never display-godot: other suites on this database (the
// MCP tools) rely on no test hangar having room for display-godot.
describe("parseHangarCapacity", () => {
  const S = "0b5f4c3e-1d2a-4b6c-8e9f-0a1b2c3d4e5f";

  it("reads the documented shape", () => {
    const raw = {
      slots: { headless: 2, "display-browser": 0 },
      blocked: { "display-browser": "ram: need 4096 MB, free 1200 MB" },
      free: { ram_mb: 12000, cpus: 4, vram_mb: 0, disk_mb: 50000 },
      sessions: { running: 1, kept: 3 },
      disk: { allocated_bytes: 8_000_000_000, apparent_bytes: 20_000_000_000 },
      usage: [{ session: S, allocated_bytes: 1024, apparent_bytes: 4096 }],
      future_field: { anything: true },
    };
    const { future_field: _ignored, ...expected } = raw;
    expect(parseHangarCapacity(raw)).toEqual(expected);
  });

  it("drops a field it can't read and keeps the rest", () => {
    expect(parseHangarCapacity({ free: "lots", slots: { headless: 1 } })).toEqual({ slots: { headless: 1 } });
  });

  it("drops negative, fractional, and non-numeric slots", () => {
    expect(parseHangarCapacity({ slots: { headless: -1, "display-browser": 1.5 } })).toEqual({ slots: {} });
    expect(parseHangarCapacity({ slots: { headless: "2", "display-browser": null } })).toEqual({ slots: {} });
    expect(parseHangarCapacity({ slots: { headless: 0, "display-browser": 3 } })).toEqual({ slots: { headless: 0, "display-browser": 3 } });
    expect(parseHangarCapacity({ slots: [1, 2] })).toEqual({});
  });

  it("keeps slots and blocked entries only for the known flavors", () => {
    expect(parseHangarCapacity({ slots: { headless: 1, gpu: 2, Headless: 3 }, blocked: { gpu: "ram: full", "display-browser": "ram: full" } })).toEqual({
      slots: { headless: 1 },
      blocked: { "display-browser": "ram: full" },
    });
  });

  it("cuts a blocked reason to 500 characters and drops a blank or non-string one", () => {
    const parsed = parseHangarCapacity({ blocked: { headless: `disk: ${"x".repeat(600)}`, "display-browser": 42, "display-godot": "  " } });
    expect(parsed.blocked!["headless"]).toHaveLength(500);
    expect(parsed.blocked!["headless"]!.startsWith("disk: ")).toBe(true);
    expect(Object.keys(parsed.blocked!)).toEqual(["headless"]);
  });

  it("flattens a blocked reason to one line: controls become a space, bidi controls go, then it is trimmed", () => {
    const parsed = parseHangarCapacity({
      blocked: {
        headless: "\tdisk:\tneed\r\n\n8192 MB,\u0085free 1200 MB\n",
        "display-browser": "\u202Eram: \u2066full\u2069\u200E\u200F\u202A\u202C",
        "display-godot": "\n\t\u202E\r",
      },
    });
    expect(parsed.blocked).toEqual({ headless: "disk: need 8192 MB, free 1200 MB", "display-browser": "ram: full" });
  });

  it("reads free, sessions, and disk whole: one bad field drops the object", () => {
    expect(parseHangarCapacity({ free: { ram_mb: 1, cpus: 2, vram_mb: 3 } })).toEqual({});
    expect(parseHangarCapacity({ free: { ram_mb: 1, cpus: 2, vram_mb: 3, disk_mb: Number.NaN } })).toEqual({});
    expect(parseHangarCapacity({ free: { ram_mb: -1, cpus: 0.5, vram_mb: 0, disk_mb: 9 } })).toEqual({ free: { ram_mb: -1, cpus: 0.5, vram_mb: 0, disk_mb: 9 } });
    expect(parseHangarCapacity({ sessions: { running: 1 } })).toEqual({});
    expect(parseHangarCapacity({ sessions: { running: 1, kept: 1.5 } })).toEqual({});
    expect(parseHangarCapacity({ sessions: { running: 1, kept: 0, extra: 9 } })).toEqual({ sessions: { running: 1, kept: 0 } });
    expect(parseHangarCapacity({ disk: { allocated_bytes: -5, apparent_bytes: 1 } })).toEqual({});
    expect(parseHangarCapacity({ disk: "full" })).toEqual({});
  });

  it("keeps usage entries with a uuid and non-negative byte counts, lowercased, at most MAX_HANGAR_USAGE_ENTRIES", () => {
    const good = { session: S.toUpperCase(), allocated_bytes: 1, apparent_bytes: 2 };
    const parsed = parseHangarCapacity({
      usage: [good, { session: "not-a-uuid", allocated_bytes: 1, apparent_bytes: 2 }, { session: S, allocated_bytes: -1, apparent_bytes: 2 }, { session: S, allocated_bytes: 1 }, "junk", null],
    });
    expect(parsed.usage).toEqual([{ session: S, allocated_bytes: 1, apparent_bytes: 2 }]);
    const many = Array.from({ length: MAX_HANGAR_USAGE_ENTRIES + 5 }, (_, i) => ({ session: S, allocated_bytes: i, apparent_bytes: i }));
    const capped = parseHangarCapacity({ usage: many }).usage!;
    expect(capped).toHaveLength(MAX_HANGAR_USAGE_ENTRIES);
    expect(capped[0]!.allocated_bytes).toBe(0);
    expect(parseHangarCapacity({ usage: { session: S } })).toEqual({});
  });

  it("fits MAX_HANGAR_USAGE_ENTRIES maximal usage entries beside realistic fields under the check-in limit", () => {
    const entry = { session: S, allocated_bytes: Number.MAX_SAFE_INTEGER, apparent_bytes: Number.MAX_SAFE_INTEGER };
    const capacity = {
      slots: { headless: 2, "display-browser": 1, "display-godot": 0 },
      blocked: { "display-godot": "disk: need 8192 MB, free 1200 MB; 3 sessions kept awaiting review" },
      free: { ram_mb: 123456, cpus: 64, vram_mb: 24576, disk_mb: 1234567 },
      sessions: { running: 12, kept: 34 },
      disk: { allocated_bytes: Number.MAX_SAFE_INTEGER, apparent_bytes: Number.MAX_SAFE_INTEGER },
      usage: Array.from({ length: MAX_HANGAR_USAGE_ENTRIES }, () => entry),
    };
    expect(JSON.stringify(capacity).length).toBeLessThan(MAX_HANGAR_CAPACITY_CHARS);
  });

  it.each([null, undefined, [], "slots", 42, true])("reads %j as empty, never throwing", (raw) => {
    expect(parseHangarCapacity(raw)).toEqual({});
  });

  it("drops a __proto__ key like any unknown flavor, never touching the prototype", () => {
    const parsed = parseHangarCapacity(JSON.parse('{"slots":{"__proto__":3,"headless":1},"blocked":{"__proto__":"disk: x"}}'));
    expect(parsed).toEqual({ slots: { headless: 1 }, blocked: {} });
    expect(Object.getPrototypeOf(parsed.slots)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.slots!, "__proto__")).toBe(false);
    expect(parseHangarCapacity(JSON.parse('{"__proto__":{"slots":{"headless":9}}}'))).toEqual({});
  });
});

describe("classifyQueuedWait", () => {
  const NOW = new Date("2026-11-14T11:00:00.000Z");
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  /** A check-in `agoMs` before NOW; its capacity reported then too, unless `capacityAgoMs` says otherwise. */
  const seen = (hangar: string, capacity: unknown, agoMs = 5_000, capacityAgoMs = agoMs): HangarCheckInSnapshot => ({
    hangar,
    lastSeenAt: new Date(NOW.getTime() - agoMs),
    intervalS: 30,
    capacity: capacity === null ? null : parseHangarCapacity(capacity),
    capacityAt: capacity === null ? null : new Date(NOW.getTime() - capacityAgoMs),
  });
  const awaitingAB = {
    total: 2,
    sessions: [
      { id: A, claimedBy: "h1", workItem: { id: "w-a", externalId: "bd-1", title: "A's work", project: "bd" } },
      { id: B, claimedBy: "h2", workItem: null },
    ],
  };
  const ctx = (checkIns: HangarCheckInSnapshot[], awaitingReview: QueuedWaitContext["awaitingReview"] = { sessions: [], total: 0 }): QueuedWaitContext => ({ now: NOW, checkIns, awaitingReview });
  const headless = { flavor: "headless", ahead: 0 };
  const DISK = "disk: need 8192 MB, free 1200 MB";

  it("offline since the newest check-in when none is online", () => {
    const ctxOffline = ctx([seen("h1", { slots: { headless: 1 } }, 2 * 3600_000), seen("h2", null, 3 * 3600_000)]);
    expect(classifyQueuedWait(headless, ctxOffline)).toEqual({ kind: "offline", since: "2026-11-14T09:00:00.000Z", text: "Waiting: hangar is offline (last check-in 2026-11-14T09:00:00.000Z)." });
  });

  it("offline, never seen, with no check-in", () => {
    expect(classifyQueuedWait(headless, ctx([]))).toEqual({ kind: "offline", since: null, text: "Waiting: hangar has never checked in. Start hangar to run it." });
  });

  it("unknown when online hangars reported no capacity; an offline one's capacity doesn't count", () => {
    const waiting = classifyQueuedWait(headless, ctx([seen("h1", null), seen("h2", { slots: { headless: 4 } }, 2 * 3600_000)]));
    expect(waiting).toEqual({ kind: "unknown", text: "Waiting: hangar is online but hasn't reported capacity yet." });
  });

  it("unknown when the online hangar's capacity is stale, naming when it was last reported", () => {
    // Online by a claim 5 s ago; its capacity is from 10 minutes before NOW.
    const stale = seen("h1", { slots: { headless: 2 } }, 5_000, 600_000);
    expect(classifyQueuedWait(headless, ctx([stale]))).toEqual({ kind: "unknown", text: "Waiting: hangar is online but its last capacity report is from 2026-11-14T10:50:00.000Z." });
    // Just inside three intervals still counts.
    expect(classifyQueuedWait(headless, ctx([seen("h1", { slots: { headless: 2 } }, 5_000, 89_000)])).kind).toBe("next");
    // A capacity with no time counts as not reported.
    const timeless = { ...seen("h1", { slots: { headless: 2 } }), capacityAt: null };
    expect(classifyQueuedWait(headless, ctx([timeless]))).toEqual({ kind: "unknown", text: "Waiting: hangar is online but hasn't reported capacity yet." });
    // A fresh capacity on another online hangar decides instead.
    expect(classifyQueuedWait(headless, ctx([stale, seen("h2", { blocked: { headless: "ram: full" } })])).kind).toBe("capacity");
  });

  it("an empty capacity still counts as reported", () => {
    expect(classifyQueuedWait(headless, ctx([seen("h1", {})])).kind).toBe("not_offered");
  });

  it("next in line, with how many are ahead", () => {
    const room = ctx([seen("h1", { slots: { headless: 1 } })]);
    expect(classifyQueuedWait(headless, room)).toEqual({ kind: "next", ahead: 0, text: "Next in line: hangar has room and should start it at its next check-in." });
    expect(classifyQueuedWait({ flavor: "headless", ahead: 1 }, room)).toEqual({ kind: "next", ahead: 1, text: "Waiting: 1 earlier headless request goes first; hangar has room for headless now." });
    expect(classifyQueuedWait({ flavor: "headless", ahead: 3 }, room).text).toBe("Waiting: 3 earlier headless requests go first; hangar has room for headless now.");
  });

  it("not offered when no online hangar names the flavor", () => {
    expect(classifyQueuedWait({ flavor: "display-godot", ahead: 0 }, ctx([seen("h1", { slots: { headless: 2 }, blocked: { "display-browser": "ram: full" } })]))).toEqual({
      kind: "not_offered",
      text: "Waiting: no online hangar runs display-godot.",
    });
  });

  it("disk awaiting review, quoting the reason, with bytes from the claimer's usage, else any online hangar's", () => {
    const h1 = seen("h1", { slots: { headless: 0 }, blocked: { headless: ` ${DISK}` }, usage: [{ session: A, allocated_bytes: 8_000, apparent_bytes: 9_000 }] });
    const waiting = classifyQueuedWait(headless, ctx([h1], awaitingAB));
    expect(waiting).toEqual({
      kind: "disk_awaiting_review",
      text: 'Waiting on disk (h1 says "need 8192 MB, free 1200 MB"). 2 ended sessions still hold disks; accept or table them to free space.',
      // Trimmed on read, so the leading space hangar sent is gone.
      reasons: [{ hangar: "h1", reason: DISK }],
      sessions: [{ ...awaitingAB.sessions[0], diskAllocatedBytes: 8_000 }, awaitingAB.sessions[1]],
      total: 2,
    });
    // B's claimer h2 lists it, and h1 lists it too: the claimer's figure wins.
    const h2 = seen("h2", { blocked: { headless: DISK }, usage: [{ session: B, allocated_bytes: 5, apparent_bytes: 5 }] });
    const h1b = seen("h1", { blocked: { headless: DISK }, usage: [{ session: B, allocated_bytes: 7, apparent_bytes: 7 }] });
    const both = classifyQueuedWait(headless, ctx([h1b, h2], awaitingAB));
    expect(both.kind === "disk_awaiting_review" && both.sessions.map((s) => s.diskAllocatedBytes)).toEqual([undefined, 5]);
  });

  it("one awaiting session reads in the singular", () => {
    const waiting = classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: DISK } })], { total: 1, sessions: [awaitingAB.sessions[1]!] }));
    expect(waiting.text).toBe('Waiting on disk (h1 says "need 8192 MB, free 1200 MB"). 1 ended session still holds a disk; accept or table it to free space.');
  });

  it("capacity when the disk is full but nothing awaits review", () => {
    expect(classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: DISK } })]))).toEqual({
      kind: "capacity",
      text: `Waiting on capacity (h1 says "${DISK}").`,
      reasons: [{ hangar: "h1", reason: DISK }],
    });
  });

  it("capacity when another budget is full, even with sessions awaiting review", () => {
    expect(classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: "ram: need 4096 MB, free 1200" } })], awaitingAB))).toEqual({
      kind: "capacity",
      text: 'Waiting on capacity (h1 says "ram: need 4096 MB, free 1200").',
      reasons: [{ hangar: "h1", reason: "ram: need 4096 MB, free 1200" }],
    });
  });

  it("no free slot for a flavor at 0 with no blocked entry", () => {
    expect(classifyQueuedWait(headless, ctx([seen("h1", { slots: { headless: 0 } })], awaitingAB))).toEqual({
      kind: "capacity",
      text: "Waiting on capacity (h1 has no free slot).",
      reasons: [{ hangar: "h1", reason: "no free slot" }],
    });
  });

  it("capacity when one hangar blocks on disk and another on RAM", () => {
    const waiting = classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: DISK } }), seen("h2", { blocked: { headless: "ram: full" } })], awaitingAB));
    expect(waiting).toEqual({ kind: "capacity", text: `Waiting on capacity (h1 says "${DISK}"; h2 says "ram: full").`, reasons: [{ hangar: "h1", reason: DISK }, { hangar: "h2", reason: "ram: full" }] });
  });

  it("next when a second online hangar has room, and an offline hangar's room is ignored", () => {
    expect(classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: "ram: full" } }), seen("h2", { slots: { headless: 1 } })])).kind).toBe("next");
    expect(classifyQueuedWait(headless, ctx([seen("h1", { blocked: { headless: "ram: full" } }), seen("h2", { slots: { headless: 1 } }, 2 * 3600_000)])).kind).toBe("capacity");
  });
});

describe("capacity on check-ins and status", () => {
  const S = randomUUID();

  it("keeps the latest capacity and its time when a claim later touches the check-in", async () => {
    const hangar = hangarNamed("cap-latest");
    const capacity = { slots: { headless: 2 }, usage: [{ session: S, allocated_bytes: 100, apparent_bytes: 200 }] };
    const { now: t1 } = await recordCheckIn(db, { hangar, version: "0.4.0", capacity });
    await db.execute(sql`UPDATE hangar_check_ins SET last_seen_at = last_seen_at - interval '1 minute', capacity_at = capacity_at - interval '1 minute' WHERE hangar = ${hangar}`);
    expect(await claimSession(db, { hangar, flavors: ["headless"], among: [randomUUID()] })).toBeNull();

    const status = await getHangarStatus(db, { hangar });
    expect(status).toMatchObject({ state: "online", hangar, capacity });
    expect(status.capacityAt!.getTime()).toBe(t1.getTime() - 60_000);
    expect(status.lastSeenAt!.getTime()).toBeGreaterThan(status.capacityAt!.getTime());
  });

  it("clears the capacity and its time on a check-in with none", async () => {
    const hangar = hangarNamed("cap-cleared");
    await recordCheckIn(db, { hangar, capacity: { slots: { headless: 1 } } });
    expect((await getHangarStatus(db, { hangar })).capacityAt).toBeInstanceOf(Date);
    await recordCheckIn(db, { hangar, capacity: null });
    expect(await getHangarStatus(db, { hangar })).toMatchObject({ capacity: null, capacityAt: null });
    const [row] = await db.select().from(hangarCheckIns).where(inArray(hangarCheckIns.hangar, [hangar]));
    expect(row).toMatchObject({ capacity: null, capacityAt: null });
  });

  it("accepts a malformed field: online, and reads the rest", async () => {
    const hangar = hangarNamed("cap-malformed");
    await recordCheckIn(db, { hangar, capacity: { free: "lots", slots: { headless: 1 } } });
    expect(await getHangarStatus(db, { hangar })).toMatchObject({ state: "online", capacity: { slots: { headless: 1 } } });
  });
});

describe("explainQueuedSessions", () => {
  const DISK = "disk: need 8192 MB, free 1200 MB";
  let blockHangars: string[] = [];

  afterEach(async () => {
    if (blockHangars.length > 0) await db.delete(hangarCheckIns).where(inArray(hangarCheckIns.hangar, blockHangars));
    blockHangars = [];
  });

  async function checkedIn(label: string, capacity: Record<string, unknown> | null): Promise<string> {
    const hangar = hangarNamed(label);
    blockHangars.push(hangar);
    await recordCheckIn(db, { hangar, capacity });
    return hangar;
  }

  async function workItem(title: string, metadata: Record<string, unknown> = { status: "open" }): Promise<{ id: string; externalId: string }> {
    const externalId = randomUUID();
    const result = await upsertNodes(db, fixtureRun, [{ nodeType: "work_item", sourceSystem: FIXTURE_SOURCE, externalId, title, metadata }]);
    const id = result.rows[0]!.id;
    fixtureNodes.push(id);
    return { id, externalId };
  }

  async function explainOne(id: string, hangars: string[], sessions: string[] = [id]) {
    const waiting = await explainQueuedSessions(db, { ids: [id], among: { hangars, sessions } });
    return waiting.get(id);
  }

  it("offline since the last check-in", async () => {
    const hangar = await checkedIn("x-offline", { slots: { headless: 1 } });
    const aged = await db.execute<{ last_seen_at: Date }>(sql`
      UPDATE hangar_check_ins SET last_seen_at = date_trunc('milliseconds', now() - interval '2 hours') WHERE hangar = ${hangar} RETURNING last_seen_at
    `);
    const since = new Date(aged.rows[0]!.last_seen_at).toISOString();
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar])).toEqual({ kind: "offline", since, text: `Waiting: hangar is offline (last check-in ${since}).` });
  });

  it("offline, never seen, when no hangar has checked in", async () => {
    const q = await request("headless");
    expect(await explainOne(q.id, [`${ACTOR_PREFIX}-ghost`])).toEqual({ kind: "offline", since: null, text: "Waiting: hangar has never checked in. Start hangar to run it." });
  });

  it("unknown when the online hangar sent no capacity", async () => {
    const hangar = await checkedIn("x-unknown", null);
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar])).toMatchObject({ kind: "unknown" });
  });

  it("unknown when the online hangar's capacity is stale, naming when it was reported", async () => {
    const hangar = await checkedIn("x-stale", { slots: { headless: 1 } });
    const aged = await db.execute<{ capacity_at: Date }>(sql`
      UPDATE hangar_check_ins SET capacity_at = date_trunc('milliseconds', now() - interval '10 minutes') WHERE hangar = ${hangar} RETURNING capacity_at
    `);
    const at = new Date(aged.rows[0]!.capacity_at).toISOString();
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar])).toEqual({ kind: "unknown", text: `Waiting: hangar is online but its last capacity report is from ${at}.` });
  });

  it("next in line, counting earlier same-flavor requests, also when asked about one alone", async () => {
    const hangar = await checkedIn("x-next", { slots: { headless: 1 } });
    const p = await request("headless");
    const q = await request("headless");
    const other = await request("display-browser");
    const all = await explainQueuedSessions(db, { among: { hangars: [hangar], sessions: [p.id, q.id, other.id] } });
    expect(all.get(p.id)).toEqual({ kind: "next", ahead: 0, text: "Next in line: hangar has room and should start it at its next check-in." });
    expect(all.get(q.id)).toEqual({ kind: "next", ahead: 1, text: "Waiting: 1 earlier headless request goes first; hangar has room for headless now." });
    expect(all.get(other.id)).toMatchObject({ kind: "not_offered" });
    const alone = await explainQueuedSessions(db, { ids: [q.id], among: { hangars: [hangar], sessions: [p.id, q.id] } });
    expect([...alone.keys()]).toEqual([q.id]);
    expect(alone.get(q.id)).toMatchObject({ kind: "next", ahead: 1 });
  });

  it("not offered when no online hangar runs the flavor", async () => {
    const hangar = await checkedIn("x-not-offered", { slots: { headless: 2 } });
    const q = await request("display-godot");
    expect(await explainOne(q.id, [hangar])).toEqual({ kind: "not_offered", text: "Waiting: no online hangar runs display-godot." });
  });

  it("disk awaiting review: quotes hangar's reason and lists A and B with their work items, A with its bytes", async () => {
    const itemA = await workItem("A's work", { status: "open", project: "bd" });
    const itemB = await workItem("B's work");
    const a = await ended("x-disk-a", "stopped", itemA.id);
    const b = await ended("x-disk-b", "stopped", itemB.id);
    const hangar = await checkedIn("x-disk", { slots: { headless: 0 }, blocked: { headless: DISK }, usage: [{ session: a.id, allocated_bytes: 8_000_000_000, apparent_bytes: 9_000_000_000 }] });
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar], [a.id, b.id, q.id])).toEqual({
      kind: "disk_awaiting_review",
      text: `Waiting on disk (${hangar} says "need 8192 MB, free 1200 MB"). 2 ended sessions still hold disks; accept or table them to free space.`,
      reasons: [{ hangar, reason: DISK }],
      sessions: [
        { id: a.id, claimedBy: a.hangar, workItem: { id: itemA.id, externalId: itemA.externalId, title: "A's work", project: "bd" }, diskAllocatedBytes: 8_000_000_000 },
        { id: b.id, claimedBy: b.hangar, workItem: { id: itemB.id, externalId: itemB.externalId, title: "B's work", project: null } },
      ],
      total: 2,
    });
  });

  it("capacity when the disk is full and nothing awaits review", async () => {
    const hangar = await checkedIn("x-disk-none", { blocked: { headless: DISK } });
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar])).toEqual({ kind: "capacity", text: `Waiting on capacity (${hangar} says "${DISK}").`, reasons: [{ hangar, reason: DISK }] });
  });

  it("capacity when RAM is full, even with a session awaiting review", async () => {
    const a = await ended("x-ram-a", "stopped");
    const hangar = await checkedIn("x-ram", { blocked: { headless: "ram: need 4096 MB, free 1200" } });
    const q = await request("headless");
    expect(await explainOne(q.id, [hangar], [a.id, q.id])).toMatchObject({ kind: "capacity", reasons: [{ hangar, reason: "ram: need 4096 MB, free 1200" }] });
  });

  it("next when a second online hangar has room", async () => {
    const ram = await checkedIn("x-room-ram", { blocked: { headless: "ram: full" } });
    const room = await checkedIn("x-room", { slots: { headless: 1 } });
    const q = await request("headless");
    expect(await explainOne(q.id, [ram, room])).toMatchObject({ kind: "next", ahead: 0 });
  });

  it("lists at most 20 awaiting sessions, oldest ended first, with the total", async () => {
    const result = await upsertNodes(
      db,
      fixtureRun,
      Array.from({ length: MAX_HANGAR_AWAITING_REVIEW_LISTED + 1 }, () => ({
        nodeType: "hangar_session",
        sourceSystem: "hangar",
        externalId: randomUUID(),
        title: "Hangar headless session: awaiting",
        metadata: { state: "stopped", flavor: "headless", repo: "cazzer/bd", claimed_by: `${ACTOR_PREFIX}-x-many`, disk_path: "/disks/x.img" },
      })),
    );
    const awaiting = result.rows.map((r) => r.id);
    sessionIds.push(...awaiting);
    const hangar = await checkedIn("x-many-disk", { blocked: { headless: DISK } });
    const q = await request("headless");
    const waiting = await explainOne(q.id, [hangar], [...awaiting, q.id]);
    expect(waiting?.kind).toBe("disk_awaiting_review");
    if (waiting?.kind !== "disk_awaiting_review") return;
    expect(waiting.total).toBe(MAX_HANGAR_AWAITING_REVIEW_LISTED + 1);
    // One batch shares an updated_at, so id breaks the tie.
    expect(waiting.sessions.map((s) => s.id)).toEqual([...awaiting].sort().slice(0, MAX_HANGAR_AWAITING_REVIEW_LISTED));
    expect(waiting.sessions.every((s) => s.workItem === null && s.diskAllocatedBytes === undefined)).toBe(true);
  });

  it("names a merged work item's survivor", async () => {
    const loser = await workItem("Merged away");
    const survivor = await workItem("Survivor");
    const a = await ended("x-merge-a", "stopped", loser.id);
    await mergeNodes(db, loser.id, survivor.id, fixtureRun);
    const hangar = await checkedIn("x-merge", { blocked: { headless: DISK } });
    const q = await request("headless");
    const waiting = await explainOne(q.id, [hangar], [a.id, q.id]);
    expect(waiting?.kind === "disk_awaiting_review" && waiting.sessions).toEqual([{ id: a.id, claimedBy: a.hangar, workItem: { id: survivor.id, externalId: survivor.externalId, title: "Survivor", project: null } }]);
  });

  it("leaves out a session that is not queued, and reads nothing for an empty id list", async () => {
    const hangar = await checkedIn("x-not-queued", { slots: { headless: 1 } });
    const a = await ended("x-not-queued-a", "stopped");
    expect((await explainQueuedSessions(db, { ids: [a.id], among: { hangars: [hangar], sessions: [a.id] } })).size).toBe(0);
    expect((await explainQueuedSessions(db, { ids: [] })).size).toBe(0);
  });

  it("refuses a bad id and more than the session limit", async () => {
    await expect(explainQueuedSessions(db, { ids: ["nope"] })).rejects.toBeInstanceOf(InvalidLookupIdError);
    const tooMany = Array.from({ length: MAX_HANGAR_SESSIONS_LIMIT + 1 }, () => randomUUID());
    await expect(explainQueuedSessions(db, { ids: tooMany })).rejects.toBeInstanceOf(InvalidHangarSessionError);
  });
});
