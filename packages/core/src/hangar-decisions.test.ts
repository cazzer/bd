// hangar-decisions.ts and hangar-escalation.ts against the real database
// (openspec/changes/hangar-driver-decisions): a worker files its result as the
// session's pending decision, never an inbox item; the driver answers it into
// the session's messages with an inbox_decision's body; an escalation goes to
// the person as a review (a review_request relay action under the work item)
// or, without a beads project, as an inbox item bound to the session; only
// the person's decision answers an escalated one, and it reaches the session
// matched on the server's own record. The database is shared with live data:
// every fixture is this file's own and cleanup is by id.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hangarDecisions, hangarMessages, nodes, relayActions, type Database } from "@breakdown/db";
import { HangarDecisionRefusedError, InvalidHangarDecisionError } from "./errors.js";
import { claimSession, getSessionsByIds, readHangarMessages, requeueSession, requestSession, setHangarSessionOutcome, updateSession } from "./hangar.js";
import {
  decideHangarDecision,
  fileHangarDecision,
  getOpenHangarDecisions,
  normalizeHangarDecisionCard,
  getHangarDecision,
  routeReviewDecision,
  unsafeLockEscalatableInTx,
} from "./hangar-decisions.js";
import { escalateHangarDecision, hangarEscalationReviewKey, onRelayActionReported } from "./hangar-escalation.js";
import { decideInboxItem, listInbox, requestInboxItem } from "./inbox.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { isAllowedBdArgs, relayReviewCreateArgs, relayReviewListArgs } from "./relay-allowlist.js";
import { claimRelayAction, getRelayAction, parseRelayPayload, reportRelayAction } from "./relay.js";
import { connectTestDb, uniqueSuffix, type TestPool } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
let fixtureRun: IngestRunHandle;
let beadsRun: IngestRunHandle;
const suffix = uniqueSuffix().slice(0, 10);
const ACTOR = `test-hdt-${suffix}`;
const FIXTURE_SOURCE = `hangar-decisions-test-${suffix}`;
const PROJECT = `hdt-${suffix}`;
const RELAY = `test-hdt-relay-${suffix}`;
const DRIVER = `driver-${suffix}`;
const fixtureNodes: string[] = [];
const sessionIds: string[] = [];

const CARD = {
  question: "Merge #12, which caches the board query?",
  options: [
    { id: "a", label: "Cache per project" },
    { id: "b", label: "Cache globally", risk: "Stale across projects" },
  ],
  recommend: "a",
  on_accept: ["merge #12"],
  body: "The board query ran 400 ms; cached, 20 ms.",
};

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  fixtureRun = await openIngestRun(db, FIXTURE_SOURCE, { actor: ACTOR });
  beadsRun = await openIngestRun(db, "beads", { actor: ACTOR });
  const registered = await upsertNodes(db, beadsRun, [{ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${PROJECT}`, title: PROJECT, content: "", metadata: { project: PROJECT, path: `/tmp/${PROJECT}` } }]);
  fixtureNodes.push(registered.rows[0]!.id);
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    await db.delete(hangarDecisions).where(inArray(hangarDecisions.sessionId, sessionIds));
    await db.delete(hangarMessages).where(inArray(hangarMessages.sessionId, sessionIds));
    await db.execute(sql`DELETE FROM client_tokens WHERE session_id = ANY(${`{${sessionIds.join(",")}}`}::uuid[])`);
  }
  await db.delete(relayActions).where(sql`payload->>'project_key' = ${PROJECT}`);
  await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id LIKE 'hangar-decision:%' AND metadata->>'session' = ANY(${`{${sessionIds.join(",")}}`}::text[])`);
  const ids = [...sessionIds, ...fixtureNodes];
  if (ids.length > 0) await db.delete(nodes).where(inArray(nodes.id, ids));
  await closeIngestRun(db, fixtureRun);
  await closeIngestRun(db, beadsRun);
  await db.execute(sql`DELETE FROM ingest_runs WHERE actor LIKE ${`${ACTOR}%`} OR actor = ${DRIVER} OR source_system = ${FIXTURE_SOURCE}`);
  await pool.end();
});

async function workItem(options: { beads?: boolean } = {}): Promise<{ id: string; externalId: string }> {
  const externalId = options.beads ? `${PROJECT}-${randomUUID().slice(0, 6)}` : randomUUID();
  const result = await upsertNodes(db, options.beads ? beadsRun : fixtureRun, [
    { nodeType: "work_item", sourceSystem: options.beads ? "beads" : FIXTURE_SOURCE, externalId, title: "Cache the board", metadata: { status: "open", ...(options.beads ? { project: PROJECT } : {}) } },
  ]);
  const id = result.rows[0]!.id;
  fixtureNodes.push(id);
  return { id, externalId };
}

/** A session for a fresh work item, claimed and running (or ended). */
async function session(options: { beads?: boolean; state?: "running" | "stopped" } = {}): Promise<{ id: string; workItem: { id: string; externalId: string } }> {
  const item = await workItem(options);
  const { session: s } = await requestSession(db, { repo: "cazzer/bd", workItemId: item.id, flavor: "headless", actor: ACTOR, requestedAt: new Date(Date.UTC(2999, 0, 1)) });
  sessionIds.push(s.id);
  const hangar = `${ACTOR}-hangar`;
  if ((await claimSession(db, { hangar, flavors: ["headless"], among: [s.id] })) === null) throw new Error("fixture claim failed");
  await updateSession(db, { hangar, id: s.id, state: "running", diskPath: `/disks/${s.id}.img` });
  if (options.state === "stopped") await updateSession(db, { hangar, id: s.id, state: "stopped" });
  return { id: s.id, workItem: item };
}

function refusal(fn: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("expected a refusal");
      },
      (err: unknown) => err,
    );
}

describe("normalizeHangarDecisionCard", () => {
  it("keeps a valid card as given, body included", () => {
    expect(normalizeHangarDecisionCard(CARD)).toEqual(CARD);
    expect(normalizeHangarDecisionCard({ question: "Go?", options: [] })).toEqual({ question: "Go?" });
  });

  it.each([
    [{ options: CARD.options }, "card.question"],
    [{ question: "x".repeat(141) }, "card"],
    [{ question: "Go?", options: [{ id: "a", label: "only one" }] }, "card"],
    [{ question: "Go?", recommend: "a" }, "card"],
    [{ question: "Go?", attachments: [] }, "card"],
    [{ question: "Go?", key: "k" }, "card"],
    ["not a card", "card"],
  ])("refuses %j naming %s, trimming nothing", (raw, field) => {
    let err: unknown;
    try {
      normalizeHangarDecisionCard(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidHangarDecisionError);
    expect((err as InvalidHangarDecisionError).field).toBe(field);
  });
});

describe("fileHangarDecision", () => {
  it("stores the session's pending decision, superseding the one before it, and files nothing in the inbox", async () => {
    const s = await session();
    const first = await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Which cache?", summary: "Two ways." });
    const second = await fileHangarDecision(db, { sessionId: s.id, kind: "pr", title: "Cache the board query", prUrl: "https://github.com/cazzer/bd/pull/12", card: CARD, filedBy: `session-${s.id}` });
    expect(second).toMatchObject({ sessionId: s.id, kind: "pr", state: "pending", card: CARD, filedBy: `session-${s.id}` });
    const open = await getOpenHangarDecisions(db, [s.id]);
    expect(open.get(s.id)?.id).toBe(second.id);
    const [old] = await db.select({ state: hangarDecisions.state }).from(hangarDecisions).where(inArray(hangarDecisions.id, [first.id]));
    expect(old?.state).toBe("superseded");
    expect((await listInbox(db, { statuses: ["pending", "undigested"] })).items.filter((i) => i.hangarSession === s.id)).toEqual([]);
  });

  it("refuses a pr without its URL, an ended session, and an unknown session, writing nothing", async () => {
    const s = await session();
    expect(await refusal(() => fileHangarDecision(db, { sessionId: s.id, kind: "pr", title: "No URL" }))).toBeInstanceOf(InvalidHangarDecisionError);
    expect(await refusal(() => fileHangarDecision(db, { sessionId: s.id, kind: "review", title: "x" }))).toBeInstanceOf(InvalidHangarDecisionError);
    const ended = await session({ state: "stopped" });
    const refused = await refusal(() => fileHangarDecision(db, { sessionId: ended.id, kind: "question", title: "Late" }));
    expect(refused).toMatchObject({ reason: "session_state" });
    expect(await refusal(() => fileHangarDecision(db, { sessionId: randomUUID(), kind: "question", title: "Who?" }))).toBeInstanceOf(HangarDecisionRefusedError);
    expect((await getOpenHangarDecisions(db, [s.id, ended.id])).size).toBe(0);
  });
});

describe("decideHangarDecision", () => {
  it("sends the driver's answer to the session with an inbox_decision's body and closes the decision", async () => {
    const s = await session();
    const filed = await fileHangarDecision(db, { sessionId: s.id, kind: "pr", title: "Cache the board query", prUrl: "https://github.com/cazzer/bd/pull/12", card: CARD });
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "accept", option: "c", actor: DRIVER }))).toMatchObject({ field: "option" });
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "changes", actor: DRIVER }))).toMatchObject({ field: "note" });
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "dismiss", option: "a", actor: DRIVER }))).toMatchObject({ field: "option" });

    const decided = await decideHangarDecision(db, { sessionId: s.id, decision: "changes", note: "Cache per project, not globally.", actor: DRIVER });
    const { messages } = await readHangarMessages(db, { sessionId: s.id });
    expect(messages).toEqual([
      {
        id: decided.messageId,
        kind: "session_decision",
        body: {
          item_id: filed.id,
          title: "Cache the board query",
          decision: "changes",
          outcome: "changes",
          message: "Cache per project, not globally.",
          text: `[decision] Sent back: "Cache the board query". Note: Cache per project, not globally. Decided by your driver (${DRIVER}). Rework it accordingly, then file your result again.`,
          by: DRIVER,
          via: "driver",
        },
        createdAt: expect.any(Date),
      },
    ]);
    expect((await getOpenHangarDecisions(db, [s.id])).size).toBe(0);
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "accept", actor: DRIVER }))).toMatchObject({ reason: "none" });
  });

  it("refuses an ended session: it reads no more messages", async () => {
    const s = await session();
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Which?" });
    await updateSession(db, { hangar: `${ACTOR}-hangar`, id: s.id, state: "stopped" });
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "accept", actor: DRIVER }))).toMatchObject({ reason: "session_ended" });
    expect((await readHangarMessages(db, { sessionId: s.id })).messages).toEqual([]);
  });
});

describe("escalateHangarDecision to a review", () => {
  it("queues a review_request under the work item; only the person's review decision answers it, and it reaches the session", async () => {
    const s = await session({ beads: true });
    const filed = await fileHangarDecision(db, { sessionId: s.id, kind: "pr", title: "Move the cache out of Postgres", prUrl: "https://github.com/cazzer/bd/pull/13", card: CARD });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, note: "It changes how Breakdown is deployed.", actor: DRIVER });
    const reviewKey = hangarEscalationReviewKey(filed.id);
    expect(reviewKey).toMatch(/^hangar-[0-9a-f]{32}$/);
    expect(escalated).toMatchObject({ via: "review", decisionId: filed.id, projectKey: PROJECT, workItem: s.workItem.externalId, reviewKey });

    // The relay's payload: the card as review metadata, under the work item, in the registered checkout.
    const [action] = await db.select().from(relayActions).where(sql`id = ${escalated.via === "review" ? escalated.relayActionId : 0}`);
    expect(action).toMatchObject({ kind: "review_request", requestedBy: DRIVER, originNodeId: s.workItem.id, state: "queued" });
    const payload = parseRelayPayload("review_request", action!.payload);
    expect(payload).toMatchObject({ project_key: PROJECT, cwd: `/tmp/${PROJECT}`, issue_id: s.workItem.externalId, title: `Review: ${CARD.question}`, review: { key: reviewKey, question: CARD.question, recommend: "a", images: [] } });
    expect(payload.description).toContain(CARD.body);
    expect(payload.description).toContain("It changes how Breakdown is deployed.");
    expect(payload.description).toContain(s.id);
    // Every command the relay will run for it is on its allowlist.
    expect(isAllowedBdArgs(relayReviewListArgs(payload.issue_id))).toBe(true);
    expect(isAllowedBdArgs(relayReviewCreateArgs({ title: payload.title, parent: payload.issue_id, description: payload.description }))).toBe(true);
    expect(isAllowedBdArgs(["update", `${PROJECT}-r1`, "--metadata", JSON.stringify({ review: payload.review })])).toBe(true);
    expect(isAllowedBdArgs(["dep", "add", payload.issue_id, `${PROJECT}-r1`, "--type", "blocks"])).toBe(true);

    // It cannot be escalated twice.
    expect(await refusal(() => escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER }))).toMatchObject({ reason: "escalated" });

    // The relay files it and reports the bead id.
    const claimed = await claimRelayAction(db, { relay: RELAY, kinds: ["review_request"], projects: [PROJECT] });
    expect(claimed?.id).toBe(action!.id);
    const reported = await reportRelayAction(db, { relay: RELAY, id: claimed!.id, state: "done", result: { review_id: `${PROJECT}-r1`, reused: false } });
    await onRelayActionReported(db, reported.action);
    expect((await getOpenHangarDecisions(db, [s.id])).get(s.id)?.escalation).toMatchObject({ via: "review", review_id: `${PROJECT}-r1` });
    // Once the review is filed, only the person answers it: the driver's decide is refused.
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "accept", option: "a", actor: DRIVER }))).toMatchObject({ reason: "escalated" });

    // A decision on some other review routes nowhere; the person's decision on this one reaches the session.
    expect(await routeReviewDecision(db, { projectKey: PROJECT, reviewId: `${PROJECT}-other`, decision: "accept", message: "", by: "human" })).toBeNull();
    const routed = await routeReviewDecision(db, { projectKey: PROJECT, reviewId: `${PROJECT}-r1`, decision: "accept", option: "b", message: "Global is fine.", by: "phone" });
    expect(routed).toMatchObject({ decisionId: filed.id, sessionId: s.id, messageId: expect.any(Number) });
    const { messages } = await readHangarMessages(db, { sessionId: s.id });
    expect(messages.map((m) => [m.kind, m.body["item_id"], m.body["decision"], m.body["option"], m.body["by"], m.body["via"]])).toEqual([["session_decision", filed.id, "accept", "b", "phone", "review"]]);
    expect(messages[0]!.body["text"]).toMatch(/Decided by the person, on the escalated review\./);
    expect((await getOpenHangarDecisions(db, [s.id])).size).toBe(0);
  });

  it("a relay failure puts the decision back to pending with the error, so the driver can retry", async () => {
    const s = await session({ beads: true });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Which store?" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: { question: "Postgres or SQLite?" }, actor: DRIVER });
    const claimed = await claimRelayAction(db, { relay: RELAY, kinds: ["review_request"], projects: [PROJECT] });
    expect(claimed?.id).toBe(escalated.via === "review" ? escalated.relayActionId : -1);
    const reported = await reportRelayAction(db, { relay: RELAY, id: claimed!.id, state: "failed", error: "bd create failed: no such issue" });
    await onRelayActionReported(db, reported.action);
    const open = (await getOpenHangarDecisions(db, [s.id])).get(s.id);
    expect(open).toMatchObject({ state: "pending", escalation: { via: "review", error: "bd create failed: no such issue" } });
    expect((await escalateHangarDecision(db, { sessionId: s.id, card: { question: "Postgres or SQLite?" }, actor: DRIVER })).via).toBe("review");
  });

  it("refuses a session with no pending decision, and a bad card, queueing nothing", async () => {
    const s = await session({ beads: true });
    expect(await refusal(() => escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER }))).toMatchObject({ reason: "none" });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Which?" });
    expect(await refusal(() => escalateHangarDecision(db, { sessionId: s.id, card: { question: "x".repeat(200) }, actor: DRIVER }))).toBeInstanceOf(InvalidHangarDecisionError);
    expect(await db.select({ id: relayActions.id }).from(relayActions).where(sql`payload->>'issue_id' = ${s.workItem.externalId}`)).toEqual([]);
  });
});

describe("escalateHangarDecision without a beads project", () => {
  it("files an inbox item bound to the session; the person's accept reaches it as a session_decision on the decision, and the item is done", async () => {
    const s = await session();
    const filed = await fileHangarDecision(db, { sessionId: s.id, kind: "pr", title: "Rewrite the store", prUrl: "https://github.com/cazzer/bd/pull/14", card: CARD });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, note: "A fundamental direction.", actor: DRIVER });
    expect(escalated).toMatchObject({ via: "inbox", decisionId: filed.id, reason: expect.stringMatching(/not beads/) });
    const itemId = escalated.via === "inbox" ? escalated.inboxItemId : "";
    const [item] = (await listInbox(db, { ids: [itemId] })).items;
    expect(item).toMatchObject({ status: "pending", hangarSession: s.id, question: CARD.question, recommend: "a" });
    expect(item!.content).toContain("A fundamental direction.");
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decision: "accept", actor: DRIVER }))).toMatchObject({ reason: "escalated" });

    const decided = await decideInboxItem(db, itemId, { decision: "accept", option: "b", message: "Go global." }, { actor: "phone" });
    expect(decided.after).toBe("done");
    const { messages } = await readHangarMessages(db, { sessionId: s.id });
    const routed = messages.find((m) => m.kind === "session_decision");
    expect(routed?.body).toMatchObject({ item_id: filed.id, decision: "accept", outcome: "accepted", option: "b", message: "Go global.", by: "phone", via: "inbox" });
    expect(messages.find((m) => m.kind === "inbox_decision")?.body["item_id"]).toBe(itemId);
    expect((await getOpenHangarDecisions(db, [s.id])).size).toBe(0);
  });
});

describe("the review_request relay payload", () => {
  const base = { project_key: "bd", cwd: "/Users/me/dev/bd", issue_id: "bd-a1", title: "Review: Go?", description: "Evidence.", review: { images: [], summary: "Go?", key: "hangar-abc", question: "Go?" } };

  it("accepts a card review with a key", () => {
    expect(parseRelayPayload("review_request", base)).toEqual(base);
  });

  it.each([
    [{ ...base, review: { images: [], summary: "Go?", question: "Go?" } }, "payload.review"],
    [{ ...base, review: { ...base.review, options: [{ id: "a", label: "only" }] } }, "payload.review"],
    [{ ...base, title: "-rf" }, "payload.title"],
    [{ ...base, description: "" }, "payload.description"],
    [{ ...base, issue_id: "--json" }, "payload.issue_id"],
    [{ ...base, extra: 1 }, "payload"],
  ])("refuses %j at %s", (raw, field) => {
    expect(() => parseRelayPayload("review_request", raw)).toThrow(field);
  });

  it("allows only the fixed bd shapes for filing a review", () => {
    expect(isAllowedBdArgs(["update", "bd-a1", "--metadata", JSON.stringify({ review: base.review, other: 1 })])).toBe(false);
    expect(isAllowedBdArgs(["update", "bd-a1", "--metadata", "{not json"])).toBe(false);
    const create = relayReviewCreateArgs({ title: "Review: Go?", parent: "bd-a1", description: "Evidence." });
    expect(isAllowedBdArgs(create.map((a) => (a === "task" ? "epic" : a)))).toBe(false);
    expect(isAllowedBdArgs(create.map((a) => (a === "review" ? "review:changes" : a)))).toBe(false);
    expect(isAllowedBdArgs(["dep", "add", "bd-a1", "bd-r1", "--type", "related"])).toBe(false);
    expect(isAllowedBdArgs(relayReviewListArgs("bd-a1").map((a) => (a === "review" ? "x" : a)))).toBe(false);
  });
});

describe("review fixes (PR #12)", () => {
  const relayFiles = async (relayActionId: number, reviewId: string) => {
    const claimed = await claimRelayAction(db, { relay: RELAY, kinds: ["review_request"], projects: [PROJECT], among: [relayActionId] });
    expect(claimed?.id).toBe(relayActionId);
    const reported = await reportRelayAction(db, { relay: RELAY, id: relayActionId, state: "done", result: { review_id: reviewId, reused: false } });
    await onRelayActionReported(db, reported.action);
    return reported;
  };
  const relayActionOf = (r: Awaited<ReturnType<typeof escalateHangarDecision>>) => (r.via === "review" ? r.relayActionId : -1);

  it("1: an option the person picks on the escalation's card reaches the session, though the worker's decision had no card", async () => {
    const s = await session({ beads: true });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Which DB?" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: { question: "Postgres or SQLite?", options: [{ id: "a", label: "Postgres" }, { id: "b", label: "SQLite" }], recommend: "a" }, actor: DRIVER });
    expect((await getOpenHangarDecisions(db, [s.id])).get(s.id)?.escalation).toMatchObject({ card: { question: "Postgres or SQLite?", recommend: "a", options: [{ id: "a" }, { id: "b" }] } });
    await relayFiles(relayActionOf(escalated), `${PROJECT}-o1`);
    await routeReviewDecision(db, { projectKey: PROJECT, reviewId: `${PROJECT}-o1`, decision: "accept", option: "b", message: "", by: "human" });
    const [message] = (await readHangarMessages(db, { sessionId: s.id })).messages;
    expect(message?.body).toMatchObject({ decision: "accept", option: "b", via: "review" });
  });

  it("2: a review_request the claim itself fails (abandoned) puts the decision back to pending, so the driver can decide or escalate again", async () => {
    const s = await session({ beads: true });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    await db.execute(sql`UPDATE relay_actions SET attempts = 3 WHERE id = ${relayActionOf(escalated)}`);
    expect(await claimRelayAction(db, { relay: RELAY, kinds: ["review_request"], projects: [PROJECT], among: [relayActionOf(escalated)] })).toBeNull();
    expect((await getRelayAction(db, relayActionOf(escalated)))?.state).toBe("failed");
    expect((await getOpenHangarDecisions(db, [s.id])).get(s.id)).toMatchObject({ state: "pending", escalation: { error: expect.stringMatching(/abandoned/) } });
    expect((await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER })).via).toBe("review");
  });

  it("2: the driver can still answer an escalation whose review is not filed yet, which withdraws the queued relay action", async () => {
    const s = await session({ beads: true });
    const filed = await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    const decided = await decideHangarDecision(db, { sessionId: s.id, decisionId: filed.id, decision: "accept", note: "Relay is away; Postgres.", actor: DRIVER });
    expect(decided.decision.state).toBe("decided");
    expect(await getRelayAction(db, relayActionOf(escalated))).toMatchObject({ state: "failed", error: expect.stringMatching(/^withdrawn: the driver decided/) });
    expect((await readHangarMessages(db, { sessionId: s.id })).messages[0]?.body).toMatchObject({ item_id: filed.id, via: "driver" });
  });

  it("2: a repeated report runs the follow-up again, so a review id lost with the first one is recorded", async () => {
    const s = await session({ beads: true });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    await claimRelayAction(db, { relay: RELAY, kinds: ["review_request"], projects: [PROJECT], among: [relayActionOf(escalated)] });
    await reportRelayAction(db, { relay: RELAY, id: relayActionOf(escalated), state: "done", result: { review_id: `${PROJECT}-l1` } });
    // The server died before its follow-up; the relay never got the answer and reports again.
    const again = await reportRelayAction(db, { relay: RELAY, id: relayActionOf(escalated), state: "done", result: { review_id: `${PROJECT}-l1` } });
    expect(again.alreadyFinished).toBe(true);
    await onRelayActionReported(db, again.action);
    expect((await getOpenHangarDecisions(db, [s.id])).get(s.id)?.escalation).toMatchObject({ review_id: `${PROJECT}-l1` });
  });

  it("3: superseding a queued escalation withdraws its relay action, and the new decision escalates on the same work item", async () => {
    const s = await session({ beads: true });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q1" });
    const first = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q2" });
    expect(await getRelayAction(db, relayActionOf(first))).toMatchObject({ state: "failed", error: expect.stringMatching(/^withdrawn: the session filed a new decision/) });
    const second = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    expect(second.via).toBe("review");
    expect(relayActionOf(second)).not.toBe(relayActionOf(first));
  });

  it("3: the escalation's lock refuses a decision superseded since it was read, so no relay action is queued for it", async () => {
    const s = await session({ beads: true });
    const read = await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q1" });
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q2" });
    expect(await refusal(() => db.transaction((tx) => unsafeLockEscalatableInTx(tx, s.id, read.id)))).toMatchObject({ reason: "superseded" });
    expect(await db.select({ id: relayActions.id }).from(relayActions).where(sql`payload->>'issue_id' = ${s.workItem.externalId}`)).toEqual([]);
  });

  it("4: a body that starts with a markdown list or rule escalates: the description starts with its heading", async () => {
    for (const body of ["- first bullet\n- second", "---\nA rule first."]) {
      const s = await session({ beads: true });
      await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q" });
      const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: { ...CARD, body }, actor: DRIVER });
      const action = await getRelayAction(db, relayActionOf(escalated));
      const payload = parseRelayPayload("review_request", action!.payload);
      expect(payload.description.startsWith(`### Escalated by the hangar driver \`${DRIVER}\``)).toBe(true);
      expect(payload.description).toContain(body);
    }
  });

  it("5: nobody but the escalation writes its inbox item: the session's own resend at that key is refused", async () => {
    const s = await session();
    await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q" });
    const escalated = await escalateHangarDecision(db, { sessionId: s.id, card: CARD, actor: DRIVER });
    const itemId = escalated.via === "inbox" ? escalated.inboxItemId : "";
    const [{ external_id: key } = { external_id: "" }] = (await db.execute<{ external_id: string }>(sql`SELECT external_id FROM nodes WHERE id = ${itemId}::uuid`)).rows;
    const err = await refusal(() => requestInboxItem(db, { externalId: key, title: "Decide: rewritten", content: "pick b", metadata: { source: "hangar", options: [{ id: "a", label: "Delete prod" }, { id: "b", label: "SQLite" }] }, actor: `session-${s.id}`, session: s.id }));
    expect((err as Error).name).toBe("ReservedInboxItemError");
    expect((await listInbox(db, { ids: [itemId] })).items[0]).toMatchObject({ title: `Decide: ${CARD.question}`, options: CARD.options });
  });

  it("6: a driver never overwrites an outcome a person set, and its note is stored", async () => {
    const s = await session({ state: "stopped" });
    const set = await setHangarSessionOutcome(db, { id: s.id, outcome: "accepted", actor: DRIVER, via: "driver", note: "PR merged:\nhttps://github.com/cazzer/bd/pull/12" });
    expect(set.session).toMatchObject({ outcome: "accepted", outcomeBy: DRIVER, outcomeVia: "driver", outcomeNote: "PR merged: https://github.com/cazzer/bd/pull/12" });
    // A driver can change its own; a person can change the driver's, and then the driver can't.
    expect((await setHangarSessionOutcome(db, { id: s.id, outcome: "tabled", actor: DRIVER, via: "driver" })).session).toMatchObject({ outcome: "tabled", outcomeNote: null });
    expect((await setHangarSessionOutcome(db, { id: s.id, outcome: "accepted", actor: "phone" })).session).toMatchObject({ outcomeVia: "person", outcomeBy: "phone" });
    expect(await refusal(() => setHangarSessionOutcome(db, { id: s.id, outcome: "tabled", actor: DRIVER, via: "driver" }))).toMatchObject({ kind: "person" });
    expect((await setHangarSessionOutcome(db, { id: s.id, outcome: "accepted", actor: DRIVER, via: "driver" })).changed).toBe(false);
    const [stored] = await getSessionsByIds(db, [s.id]);
    expect(stored).toMatchObject({ outcome: "accepted", outcomeBy: "phone" });
  });

  it("7a: a decisionId the driver read is refused once the session has filed another", async () => {
    const s = await session();
    const read = await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q1" });
    const current = await fileHangarDecision(db, { sessionId: s.id, kind: "question", title: "Q2" });
    expect(await refusal(() => decideHangarDecision(db, { sessionId: s.id, decisionId: read.id, decision: "accept", actor: DRIVER }))).toMatchObject({ reason: "superseded" });
    expect((await readHangarMessages(db, { sessionId: s.id })).messages).toEqual([]);
    expect((await decideHangarDecision(db, { sessionId: s.id, decisionId: current.id, decision: "dismiss", actor: DRIVER })).decision.id).toBe(current.id);
  });

  it("7b: the person's decision reaches a requeued (queued) session's stream, for its next worker", async () => {
    // Requeue is only from claimed: a session claimed, its decision escalated and filed, then given back.
    const item = await workItem({ beads: true });
    const { session: q } = await requestSession(db, { repo: "cazzer/bd", workItemId: item.id, flavor: "headless", actor: ACTOR, requestedAt: new Date(Date.UTC(2999, 0, 1)) });
    sessionIds.push(q.id);
    const hangar = `${ACTOR}-hangar`;
    await claimSession(db, { hangar, flavors: ["headless"], among: [q.id] });
    const filed = await fileHangarDecision(db, { sessionId: q.id, kind: "question", title: "Q" });
    const escalated = await escalateHangarDecision(db, { sessionId: q.id, card: CARD, actor: DRIVER });
    await relayFiles(relayActionOf(escalated), `${PROJECT}-q1`);
    await requeueSession(db, { hangar, id: q.id, reason: "disk budget full" });
    const routed = await routeReviewDecision(db, { projectKey: PROJECT, reviewId: `${PROJECT}-q1`, decision: "changes", message: "Use SQLite.", by: "phone" });
    expect(routed?.messageId).toEqual(expect.any(Number));
    expect((await readHangarMessages(db, { sessionId: q.id })).messages[0]?.body).toMatchObject({ item_id: filed.id, decision: "changes", via: "review" });
    expect((await getHangarDecision(db, filed.id))?.state).toBe("decided");
  });
});
