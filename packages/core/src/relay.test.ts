// relay.ts against the real database (laptop-relay spec: "The relay claims
// and reports actions", "Only allowlisted commands run", "Relay status is
// visible"). The database is shared with live data: every fixture is this
// file's own (project keys and relay names carry this run's suffix), every
// claim names its fixtures through `among` so it can never take a real
// queued action, and nothing asserts on a table as a whole. Cleanup is by
// action id and relay name.

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relayActions, relayCheckIns, type Database } from "@breakdown/db";
import { InvalidRelayActionError, RelayActionNotClaimedByError, RelayActionNotFoundError, RelayActionPendingError } from "./errors.js";
import {
  claimRelayAction,
  classifyRelayStatus,
  enqueueRelayAction,
  findOpenRelayAction,
  getRelayAction,
  getRelayStatus,
  MAX_RELAY_ATTEMPTS,
  parseRelayPayload,
  recordRelayCheckIn,
  RELAY_RECLAIM_AFTER_S,
  reportRelayAction,
  requeueRelayAction,
  type RelayActionKind,
} from "./relay.js";
import { connectTestDb, uniqueSuffix, type TestPool } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
const suffix = uniqueSuffix().slice(0, 12).toLowerCase();
const PREFIX = `test-rly-${suffix}`;
const REQUESTER = `${PREFIX}-requester`;
const actionIds: number[] = [];
const relays: string[] = [];
let projects = 0;

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  if (actionIds.length > 0) await db.delete(relayActions).where(inArray(relayActions.id, actionIds));
  await db.execute(sql`DELETE FROM relay_actions WHERE payload->>'project_key' LIKE ${`${PREFIX}%`} OR payload->>'pane' LIKE ${`${PREFIX}%`}`);
  if (relays.length > 0) await db.delete(relayCheckIns).where(inArray(relayCheckIns.relay, relays));
  await pool.end();
});

function relayNamed(label: string): string {
  const name = `${PREFIX}-${label}`;
  relays.push(name);
  return name;
}

function projectKey(): string {
  projects += 1;
  return `${PREFIX}-p${projects}`;
}

function reviewPayload(project: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_key: project,
    cwd: "/Users/test/checkout",
    issue_id: "test-1",
    decision: "accept",
    message: "ship it",
    option: "B",
    seen: { question: "Which?", label: "Option B" },
    ...overrides,
  };
}

async function enqueue(kind: RelayActionKind, payload: unknown): Promise<number> {
  const { action } = await enqueueRelayAction(db, { kind, payload, requestedBy: REQUESTER });
  actionIds.push(action.id);
  return action.id;
}

async function age(id: number, seconds = RELAY_RECLAIM_AFTER_S + 1): Promise<void> {
  await db.execute(sql`UPDATE relay_actions SET claimed_at = now() - make_interval(secs => ${seconds}) WHERE id = ${id}`);
}

describe("enqueueRelayAction", () => {
  it("queues a valid review decision with its requester and origin", async () => {
    const origin = "00000000-0000-4000-8000-000000000001";
    const { action, created } = await enqueueRelayAction(db, { kind: "review_decision", payload: reviewPayload(projectKey()), requestedBy: REQUESTER, originNodeId: origin });
    actionIds.push(action.id);
    expect(created).toBe(true);
    expect(action).toMatchObject({ kind: "review_decision", state: "queued", attempts: 0, claimedBy: null, requestedBy: REQUESTER, originNodeId: origin });
    expect(await getRelayAction(db, action.id)).toEqual(action);
    expect(await getRelayAction(db, String(action.id))).toEqual(action);
  });

  it.each([
    ["an unknown key", "review_decision", (p: string) => reviewPayload(p, { notify: { pane: "w1", socket: "/tmp/s" } }), "payload"],
    ["a bad issue id", "review_decision", (p: string) => reviewPayload(p, { issue_id: "--all" }), "payload.issue_id"],
    ["a relative cwd", "review_decision", (p: string) => reviewPayload(p, { cwd: "checkout" }), "payload.cwd"],
    ["a changes decision with no message", "review_decision", (p: string) => reviewPayload(p, { decision: "changes", message: " ", option: undefined, seen: undefined }), "payload.message"],
    ["an option without what was seen", "review_decision", (p: string) => reviewPayload(p, { seen: undefined }), "payload.seen"],
    ["an unknown decision", "review_decision", (p: string) => reviewPayload(p, { decision: "delete" }), "payload.decision"],
    ["a bad project key", "beads_reingest", () => ({ project_key: "../etc" }), "payload.project_key"],
    ["a bad pane", "herdr_prompt", () => ({ pane: `${PREFIX}/x`, socket: "/tmp/herdr.sock", text: "hi" }), "payload.pane"],
    ["a herdr text that reads as a flag", "herdr_prompt", () => ({ pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "-x" }), "payload.text"],
    ["a relative socket", "herdr_prompt", () => ({ pane: `${PREFIX}-pane`, socket: "herdr.sock", text: "hi" }), "payload.socket"],
    ["a non-object payload", "beads_reingest", () => "project", "payload"],
  ] as const)("refuses a forged payload with %s, and writes nothing", async (_label, kind, build, field) => {
    const project = projectKey();
    const err = await enqueueRelayAction(db, { kind, payload: build(project), requestedBy: REQUESTER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRelayActionError);
    expect((err as InvalidRelayActionError).field).toBe(field);
    const rows = await db.execute(sql`SELECT 1 FROM relay_actions WHERE payload->>'project_key' = ${project}`);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses an unknown kind, a missing requester, and a malformed origin", async () => {
    const payload = { project_key: projectKey() };
    await expect(enqueueRelayAction(db, { kind: "bd_delete" as RelayActionKind, payload, requestedBy: REQUESTER })).rejects.toBeInstanceOf(InvalidRelayActionError);
    await expect(enqueueRelayAction(db, { kind: "beads_reingest", payload, requestedBy: " " })).rejects.toBeInstanceOf(InvalidRelayActionError);
    await expect(enqueueRelayAction(db, { kind: "beads_reingest", payload, requestedBy: REQUESTER, originNodeId: "x" })).rejects.toBeInstanceOf(InvalidRelayActionError);
  });

  it("refuses a second open review decision on the same review, naming the open one, and allows one once it is done", async () => {
    const project = projectKey();
    const first = await enqueue("review_decision", reviewPayload(project));
    const err = await enqueueRelayAction(db, { kind: "review_decision", payload: reviewPayload(project, { decision: "changes", message: "no", option: undefined, seen: undefined }), requestedBy: REQUESTER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayActionPendingError);
    expect((err as RelayActionPendingError).openActionId).toBe(first);
    expect((await findOpenRelayAction(db, { kind: "review_decision", projectKey: project, issueId: "test-1" }))?.id).toBe(first);

    // Another review in the same project is another target.
    await enqueue("review_decision", reviewPayload(project, { issue_id: "test-2" }));

    const relay = relayNamed("pending");
    expect((await claimRelayAction(db, { relay, among: [first] }))?.id).toBe(first);
    await expect(enqueueRelayAction(db, { kind: "review_decision", payload: reviewPayload(project), requestedBy: REQUESTER })).rejects.toBeInstanceOf(RelayActionPendingError);
    await reportRelayAction(db, { relay, id: first, state: "done", result: { note: "already applied" } });
    const again = await enqueue("review_decision", reviewPayload(project));
    expect(again).not.toBe(first);
  });

  it("folds a second re-ingest of a project into the open one", async () => {
    const project = projectKey();
    const first = await enqueueRelayAction(db, { kind: "beads_reingest", payload: { project_key: project }, requestedBy: REQUESTER });
    actionIds.push(first.action.id);
    const second = await enqueueRelayAction(db, { kind: "beads_reingest", payload: { project_key: project }, requestedBy: `${REQUESTER}-2` });
    expect(second).toMatchObject({ created: false, action: { id: first.action.id, requestedBy: REQUESTER } });
  });

  it("never folds herdr prompts together", async () => {
    const payload = { pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "Your item was accepted" };
    const a = await enqueue("herdr_prompt", payload);
    const b = await enqueue("herdr_prompt", payload);
    expect(a).not.toBe(b);
  });
});

describe("claimRelayAction", () => {
  it("hands one queued action to exactly one of eight racing claims", async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimRelayAction(db, { relay: relayNamed(`race-${i}`), among: [id] })));
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ id, state: "claimed", attempts: 1, payload: { project_key: expect.any(String) } });
    expect((await getRelayAction(db, id))?.attempts).toBe(1);
  });

  it("takes the oldest first, only of the admitted kinds, and returns null when none is left", async () => {
    const relay = relayNamed("order");
    const review = await enqueue("review_decision", reviewPayload(projectKey()));
    const reingest = await enqueue("beads_reingest", { project_key: projectKey() });
    const among = [review, reingest];
    expect((await claimRelayAction(db, { relay, kinds: ["beads_reingest"], among }))?.id).toBe(reingest);
    const claimed = await claimRelayAction(db, { relay, among });
    expect(claimed).toMatchObject({ id: review, kind: "review_decision", payload: { issue_id: "test-1", option: "B" } });
    expect(await claimRelayAction(db, { relay, among })).toBeNull();
    await expect(claimRelayAction(db, { relay, kinds: [], among })).rejects.toBeInstanceOf(InvalidRelayActionError);
    await expect(claimRelayAction(db, { relay, kinds: ["shell"], among })).rejects.toBeInstanceOf(InvalidRelayActionError);
  });

  it("reclaims an action whose claim is older than the reclaim window, counting the attempt", async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const dead = relayNamed("dead");
    const live = relayNamed("live");
    await claimRelayAction(db, { relay: dead, among: [id] });
    expect(await claimRelayAction(db, { relay: live, among: [id] })).toBeNull();
    await age(id, RELAY_RECLAIM_AFTER_S - 10);
    expect(await claimRelayAction(db, { relay: live, among: [id] })).toBeNull();
    await age(id);
    expect(await claimRelayAction(db, { relay: live, among: [id] })).toMatchObject({ id, state: "claimed", claimedBy: live, attempts: 2 });
    await expect(reportRelayAction(db, { relay: dead, id, state: "done" })).rejects.toBeInstanceOf(RelayActionNotClaimedByError);
  });

  it(`fails an action claimed ${MAX_RELAY_ATTEMPTS} times without a report at its next claim, and moves on`, async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const next = await enqueue("beads_reingest", { project_key: projectKey() });
    const relay = relayNamed("attempts");
    for (let i = 1; i <= MAX_RELAY_ATTEMPTS; i += 1) {
      expect(await claimRelayAction(db, { relay, among: [id] })).toMatchObject({ id, attempts: i });
      await age(id);
    }
    expect((await claimRelayAction(db, { relay, among: [id, next] }))?.id).toBe(next);
    expect(await getRelayAction(db, id)).toMatchObject({ state: "failed", attempts: MAX_RELAY_ATTEMPTS, error: `abandoned after ${MAX_RELAY_ATTEMPTS} claims without a report` });
    expect((await getRelayAction(db, id))?.finishedAt).toBeInstanceOf(Date);
  });

  it("fails a stored row whose payload breaks its schema instead of handing it to the relay", async () => {
    const project = projectKey();
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO relay_actions (kind, payload, requested_by)
      VALUES ('herdr_prompt', ${JSON.stringify({ pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "--help", project_key: project })}::jsonb, ${REQUESTER})
      RETURNING id
    `);
    const forged = Number(inserted.rows[0]!.id);
    actionIds.push(forged);
    const good = await enqueue("beads_reingest", { project_key: projectKey() });
    const claimed = await claimRelayAction(db, { relay: relayNamed("forged"), among: [forged, good] });
    expect(claimed?.id).toBe(good);
    const failed = await getRelayAction(db, forged);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toMatch(/stored payload breaks the herdr_prompt schema/);
  });

  it("counts as a check-in even when it finds nothing", async () => {
    const relay = relayNamed("idle");
    expect(await claimRelayAction(db, { relay, among: [] })).toBeNull();
    expect((await getRelayStatus(db, { relay })).state).toBe("online");
  });
});

describe("reportRelayAction and requeueRelayAction", () => {
  it("finishes an action the relay holds, refuses another relay, and is a no-op the second time", async () => {
    const id = await enqueue("review_decision", reviewPayload(projectKey()));
    const relay = relayNamed("reporter");
    await claimRelayAction(db, { relay, among: [id] });

    await expect(reportRelayAction(db, { relay: relayNamed("other"), id, state: "done" })).rejects.toBeInstanceOf(RelayActionNotClaimedByError);
    const first = await reportRelayAction(db, { relay, id, state: "done", result: { written: ["comment", "close"] } });
    expect(first).toMatchObject({ alreadyFinished: false, action: { state: "done", result: { written: ["comment", "close"] }, error: null } });
    expect(first.action.finishedAt).toBeInstanceOf(Date);

    const second = await reportRelayAction(db, { relay, id, state: "failed", error: "late" });
    expect(second).toMatchObject({ alreadyFinished: true, action: { state: "done", error: null } });
  });

  it("records a failure's error, cut to fit, and requires one", async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const relay = relayNamed("failer");
    await claimRelayAction(db, { relay, among: [id] });
    await expect(reportRelayAction(db, { relay, id, state: "failed" })).rejects.toBeInstanceOf(InvalidRelayActionError);
    await expect(reportRelayAction(db, { relay, id, state: "done", error: "x" })).rejects.toBeInstanceOf(InvalidRelayActionError);
    const { action } = await reportRelayAction(db, { relay, id, state: "failed", error: `bd: not a checkout\u0007 ${"x".repeat(5000)}` });
    expect(action.state).toBe("failed");
    expect(action.error?.startsWith("bd: not a checkout x")).toBe(true);
    expect(action.error?.length).toBeLessThanOrEqual(2000);
  });

  it("refuses a report of a queued action and of an unknown id", async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const relay = relayNamed("early");
    await expect(reportRelayAction(db, { relay, id, state: "done" })).rejects.toBeInstanceOf(RelayActionNotClaimedByError);
    await expect(reportRelayAction(db, { relay, id: 999_999_999_999, state: "done" })).rejects.toBeInstanceOf(RelayActionNotFoundError);
    await expect(reportRelayAction(db, { relay, id: "0", state: "done" })).rejects.toBeInstanceOf(InvalidRelayActionError);
  });

  it("requeues an action the relay holds, giving back its attempt, and refuses another relay", async () => {
    const id = await enqueue("beads_reingest", { project_key: projectKey() });
    const relay = relayNamed("requeuer");
    await claimRelayAction(db, { relay, among: [id] });
    await expect(requeueRelayAction(db, { relay: relayNamed("thief"), id, reason: "mine" })).rejects.toBeInstanceOf(RelayActionNotClaimedByError);
    const requeued = await requeueRelayAction(db, { relay, id, reason: "shutting down" });
    expect(requeued).toMatchObject({ state: "queued", claimedBy: null, claimedAt: null, attempts: 0, error: "shutting down" });
    expect(await claimRelayAction(db, { relay, among: [id] })).toMatchObject({ id, attempts: 1, error: null });
  });
});

describe("relay status", () => {
  it("reports never for a relay that has not checked in", async () => {
    expect(await getRelayStatus(db, { relay: `${PREFIX}-ghost` })).toMatchObject({ state: "never", lastSeenAt: null, relay: null });
  });

  it("reports online after a check-in and offline since it once three intervals pass", async () => {
    const relay = relayNamed("status");
    const checkIn = await recordRelayCheckIn(db, { relay, version: "0.1.0" });
    expect(checkIn.intervalS).toBe(30);
    const online = await getRelayStatus(db, { relay });
    expect(online).toMatchObject({ state: "online", relay, version: "0.1.0", intervalS: 30 });
    expect(online.counts).toEqual({ queued: expect.any(Number), claimed: expect.any(Number) });

    await db.execute(sql`UPDATE relay_check_ins SET last_seen_at = now() - interval '2 hours' WHERE relay = ${relay}`);
    const offline = await getRelayStatus(db, { relay });
    expect(offline.state).toBe("offline");
    expect(offline.now.getTime() - offline.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 1000);
  });

  it("classifyRelayStatus: online under three intervals, offline from then on, never with no row", () => {
    const lastSeenAt = new Date("2026-01-01T00:00:00.000Z");
    const at = (ms: number) => new Date(lastSeenAt.getTime() + ms);
    expect(classifyRelayStatus(null, at(0))).toEqual({ state: "never", lastSeenAt: null });
    expect(classifyRelayStatus({ lastSeenAt, intervalS: 30 }, at(89_999))).toEqual({ state: "online", lastSeenAt });
    expect(classifyRelayStatus({ lastSeenAt, intervalS: 30 }, at(90_000))).toEqual({ state: "offline", lastSeenAt });
  });
});

describe("parseRelayPayload", () => {
  it("returns the payload of a valid action and names the field of an invalid one", () => {
    expect(parseRelayPayload("beads_reingest", { project_key: "breakdown" })).toEqual({ project_key: "breakdown" });
    expect(() => parseRelayPayload("review_decision", reviewPayload("breakdown", { issue_id: "BD 1" }))).toThrow(/payload\.issue_id/);
    expect(() => parseRelayPayload("shell" as RelayActionKind, {})).toThrow(InvalidRelayActionError);
  });
});
