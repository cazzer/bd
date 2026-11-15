// relay.ts against the real database (laptop-relay spec: "The relay claims
// and reports actions", "Only allowlisted commands run", "Relay status is
// visible"). The database is shared with live data: every fixture is this
// file's own (project keys and relay names carry this run's suffix), every
// claim names its fixtures through `among` so it can never take a real
// queued action, and nothing asserts on a table as a whole. Cleanup is by
// action id and relay name.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relayActions, relayCheckIns, type Database } from "@breakdown/db";
import { InvalidRelayActionError, RelayActionNotClaimedByError, RelayActionNotFoundError, RelayActionPendingError } from "./errors.js";
import {
  fitRelayHerdrText,
  MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH,
  MAX_RELAY_HERDR_TEXT_LENGTH,
  RELAY_HERDR_TRUNCATED_SUFFIX,
  RELAY_PROVENANCE_LINE,
  RELAY_PROVENANCE_SEPARATOR,
  withRelayProvenance,
} from "./relay-allowlist.js";
import {
  claimRelayAction,
  classifyRelayStatus,
  enqueueRelayAction,
  findOpenRelayAction,
  getRelayAction,
  getRelayStatus,
  listRelayActionsForOrigins,
  MAX_RELAY_ATTEMPTS,
  MAX_RELAY_ORIGIN_IDS,
  MAX_RELAY_CLAIM_PROJECTS,
  parseRelayPayload,
  RELAY_MAX_AGE_S,
  RELAY_ORIGIN_RECENT_S,
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

/** Backdates an action's `created_at` by `seconds`. */
async function queuedAgo(id: number, seconds: number): Promise<void> {
  await db.execute(sql`UPDATE relay_actions SET created_at = now() - make_interval(secs => ${seconds}) WHERE id = ${id}`);
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
    ["a herdr text with no room left for the relay's provenance line", "herdr_prompt", () => ({ pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "x".repeat(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH + 1) }), "payload.text"],
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

  it("takes only actions of the projects named, and a herdr prompt by kind alone", async () => {
    const relay = relayNamed("projects");
    const mine = projectKey();
    const theirs = projectKey();
    const theirsReview = await enqueue("review_decision", reviewPayload(theirs));
    const theirsReingest = await enqueue("beads_reingest", { project_key: theirs });
    const prompt = await enqueue("herdr_prompt", { pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "Your item was accepted" });
    const mineReview = await enqueue("review_decision", reviewPayload(mine));
    const among = [theirsReview, theirsReingest, prompt, mineReview];

    // A relay narrowed to `mine` never claims `theirs`, whatever the kind.
    expect((await claimRelayAction(db, { relay, projects: [mine], among }))?.id).toBe(prompt);
    expect((await claimRelayAction(db, { relay, projects: [mine], among }))?.id).toBe(mineReview);
    expect(await claimRelayAction(db, { relay, projects: [mine], among })).toBeNull();
    expect(await claimRelayAction(db, { relay, projects: [], among })).toBeNull();
    expect(await getRelayAction(db, theirsReview)).toMatchObject({ state: "queued", attempts: 0 });
    expect(await getRelayAction(db, theirsReingest)).toMatchObject({ state: "queued", attempts: 0 });

    // A herdr prompt is excluded only by kind.
    const prompt2 = await enqueue("herdr_prompt", { pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "Again" });
    expect(await claimRelayAction(db, { relay, projects: [mine], kinds: ["review_decision", "beads_reingest"], among: [prompt2] })).toBeNull();

    // Omitting projects serves every project, as before.
    expect((await claimRelayAction(db, { relay, among }))?.id).toBe(theirsReview);

    await expect(claimRelayAction(db, { relay, projects: ["../etc"], among })).rejects.toBeInstanceOf(InvalidRelayActionError);
    await expect(claimRelayAction(db, { relay, projects: Array.from({ length: MAX_RELAY_CLAIM_PROJECTS + 1 }, (_, i) => `p${i}`), among })).rejects.toBeInstanceOf(InvalidRelayActionError);
  });

  it(`fails a review decision or herdr prompt queued over ${RELAY_MAX_AGE_S / 3600} h ago as stale, but never a re-ingest`, async () => {
    const relay = relayNamed("stale");
    const review = await enqueue("review_decision", reviewPayload(projectKey()));
    const prompt = await enqueue("herdr_prompt", { pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "Old news" });
    const reingest = await enqueue("beads_reingest", { project_key: projectKey() });
    const fresh = await enqueue("review_decision", reviewPayload(projectKey()));
    for (const id of [review, prompt, reingest]) await queuedAgo(id, RELAY_MAX_AGE_S + 60);
    await queuedAgo(fresh, RELAY_MAX_AGE_S - 600);

    // The two stale rows are failed in the claim's transaction, and the claim moves on to the re-ingest.
    expect((await claimRelayAction(db, { relay, among: [review, prompt, reingest, fresh] }))?.id).toBe(reingest);
    for (const id of [review, prompt]) {
      const failed = await getRelayAction(db, id);
      expect(failed).toMatchObject({ state: "failed", attempts: 0 });
      expect(failed?.error).toBe(`stale: queued ${failed!.createdAt.toISOString()}, older than 24 h`);
      expect(failed?.finishedAt).toBeInstanceOf(Date);
    }
    expect((await claimRelayAction(db, { relay, among: [fresh] }))?.id).toBe(fresh);
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

describe("listRelayActionsForOrigins", () => {
  // Origins are random per run, so no other row can answer for them; a
  // finished state is set on the fixture rows directly (no claim runs).
  const origin = () => randomUUID();

  async function queuedFor(originNodeId: string, kind: RelayActionKind = "review_decision"): Promise<number> {
    const payload = kind === "review_decision" ? reviewPayload(projectKey()) : { pane: `${PREFIX}-pane`, socket: "/tmp/herdr.sock", text: "told" };
    const { action } = await enqueueRelayAction(db, { kind, payload, requestedBy: REQUESTER, originNodeId });
    actionIds.push(action.id);
    return action.id;
  }

  async function finish(id: number, state: "done" | "failed", agoS = 0): Promise<void> {
    await db.execute(sql`
      UPDATE relay_actions SET state = ${state}, finished_at = now() - make_interval(secs => ${agoS}),
        error = ${state === "failed" ? "bd: issue not found" : null}
      WHERE id = ${id}
    `);
  }

  it("answers the open action of an origin over a later finished one", async () => {
    const o = origin();
    const failed = await queuedFor(o, "herdr_prompt");
    await finish(failed, "failed");
    const open = await queuedFor(o, "herdr_prompt");
    const [only, ...rest] = await listRelayActionsForOrigins(db, { originNodeIds: [o] });
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: open, state: "queued", originNodeId: o });
  });

  it(`answers the most recently finished action, within ${RELAY_ORIGIN_RECENT_S / 3600} h, and nothing for an origin with none`, async () => {
    const recent = origin();
    const older = await queuedFor(recent, "herdr_prompt");
    const newer = await queuedFor(recent, "herdr_prompt");
    await finish(older, "done", 60);
    await finish(newer, "failed", 10);
    const stale = origin();
    await finish(await queuedFor(stale), "failed", RELAY_ORIGIN_RECENT_S + 60);
    const none = origin();

    const answer = await listRelayActionsForOrigins(db, { originNodeIds: [recent, stale, none, recent] });
    expect(answer.map((a) => [a.originNodeId, a.id, a.state, a.error])).toEqual([[recent, newer, "failed", "bd: issue not found"]]);
  });

  it("answers one action per origin, in origin order, up to the limit", async () => {
    const origins = [origin(), origin(), origin()];
    const ids = [];
    for (const o of origins) ids.push(await queuedFor(o));
    const answer = await listRelayActionsForOrigins(db, { originNodeIds: origins });
    expect(answer.map((a) => a.originNodeId)).toEqual([...origins].sort());
    expect(answer.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(await listRelayActionsForOrigins(db, { originNodeIds: origins, limit: 2 })).toHaveLength(2);
  });

  it(`refuses more than ${MAX_RELAY_ORIGIN_IDS} origins, a malformed one, and a bad limit; reads nothing for none`, async () => {
    const many = Array.from({ length: MAX_RELAY_ORIGIN_IDS + 1 }, origin);
    await expect(listRelayActionsForOrigins(db, { originNodeIds: many })).rejects.toThrow(InvalidRelayActionError);
    await expect(listRelayActionsForOrigins(db, { originNodeIds: many.slice(0, MAX_RELAY_ORIGIN_IDS) })).resolves.toEqual([]);
    await expect(listRelayActionsForOrigins(db, { originNodeIds: ["not-a-uuid"] })).rejects.toThrow(/originNodeIds/);
    await expect(listRelayActionsForOrigins(db, { originNodeIds: [origin()], limit: 0 })).rejects.toThrow(/limit/);
    expect(await listRelayActionsForOrigins(db, { originNodeIds: [] })).toEqual([]);
  });

  it("has its origin index (migration 0010)", async () => {
    const index = await db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'relay_actions_origin_idx'`);
    expect(index.rows[0]?.indexdef).toMatch(/\(origin_node_id\) WHERE \(origin_node_id IS NOT NULL\)/);
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

describe("the provenance line's room", () => {
  it("leaves the prompt as the relay sends it within the herdr cap", () => {
    expect(RELAY_PROVENANCE_LINE.length + RELAY_PROVENANCE_SEPARATOR.length + MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH).toBe(MAX_RELAY_HERDR_TEXT_LENGTH);
    expect(withRelayProvenance("x".repeat(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH))).toHaveLength(MAX_RELAY_HERDR_TEXT_LENGTH);
    expect(() => parseRelayPayload("herdr_prompt", { pane: "w1:p1", socket: "/tmp/h.sock", text: "x".repeat(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH) })).not.toThrow();
  });

  it("fits a prompt over the payload cap to it, ending with the truncation note and never splitting a surrogate pair", () => {
    const fits = "x".repeat(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH);
    expect(fitRelayHerdrText(fits)).toBe(fits);
    const cut = fitRelayHerdrText(`${fits}y`);
    expect(cut).toHaveLength(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH);
    expect(cut.endsWith(RELAY_HERDR_TRUNCATED_SUFFIX)).toBe(true);
    expect(() => parseRelayPayload("herdr_prompt", { pane: "w1:p1", socket: "/tmp/h.sock", text: cut })).not.toThrow();
    const keep = MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH - RELAY_HERDR_TRUNCATED_SUFFIX.length;
    const astral = fitRelayHerdrText(`${"x".repeat(keep - 1)}😀${"x".repeat(100)}`);
    expect(astral).toBe(`${"x".repeat(keep - 1)}${RELAY_HERDR_TRUNCATED_SUFFIX}`);
  });

  it("keeps the provenance on the prompt's own line, so herdr cannot submit the prefix alone", () => {
    expect(RELAY_PROVENANCE_SEPARATOR).not.toMatch(/[\r\n]/);
    const sent = withRelayProvenance("[inbox] Accepted: \"x\".");
    expect(sent.split("\n")).toHaveLength(1);
    expect(sent).toBe(`${RELAY_PROVENANCE_LINE} — [inbox] Accepted: "x".`);
  });
});
