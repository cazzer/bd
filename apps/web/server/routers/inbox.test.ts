import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { closeIngestRun, getRelayAction, HostBinaryUnavailableError, inboxNotifyText, listInbox, MAX_INBOX_FEEDBACK_LENGTH, MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH, openIngestRun, requestInboxItem, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, hangarMessages, ingestRuns, nodes, relayActions, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../router.js";
import type { RunHerdrJson } from "../herdr-session.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
const KEY = `session:inbox-router-${randomUUID().slice(0, 8)}`;
const SESSIONS: string[] = [];
const SESSION_NODES: string[] = [];
/** Relay actions this file queued, deleted by id; nothing here claims them. */
const ACTION_IDS: number[] = [];
let run: IngestRunHandle;
const CARD = { question: "Track or ignore?", options: [{ id: "track", label: "Track" }, { id: "ignore", label: "Ignore" }], recommend: "ignore" };

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, `inbox-router-test-${KEY.slice(-8)}`, { actor: `test-${KEY}` });
});

afterAll(async () => {
  if (ACTION_IDS.length > 0) await db.delete(relayActions).where(inArray(relayActions.id, ACTION_IDS));
  if (SESSIONS.length > 0) await db.delete(hangarMessages).where(inArray(hangarMessages.sessionId, SESSIONS));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), like(nodes.externalId, `${KEY}%`)));
  if (SESSION_NODES.length > 0) await db.delete(nodes).where(inArray(nodes.id, SESSION_NODES));
  await closeIngestRun(db, run);
  await db.delete(ingestRuns).where(eq(ingestRuns.id, run.id));
  await pool.end();
});

/** A hangar session node in `state`, written straight to the store: never queued, so no real hangar can claim it. */
async function sessionNode(state: string): Promise<string> {
  const result = await upsertNodes(db, run, [
    { nodeType: "hangar_session", sourceSystem: "hangar", externalId: randomUUID(), title: "test session", metadata: { state, flavor: "headless", repo: "test/repo", claimed_by: `test-${KEY.slice(-8)}` } },
  ]);
  const id = result.rows[0]!.id;
  SESSIONS.push(id);
  SESSION_NODES.push(id);
  return id;
}

const caller = (readOnly = false) => createCallerFactory(appRouter)({ db, readOnly });

describe("inboxDecision with a card", () => {
  it("serves the card, accepts a named option, and refuses a moved card with 409", async () => {
    const { id } = await requestInboxItem(db, { externalId: `${KEY}-card`, title: "Batch", content: "evidence", metadata: { source: "fathom", ...CARD } });
    const [item] = (await caller().inbox({ statuses: ["pending"] })).items.filter((i) => i.id === id);
    expect(item).toMatchObject({ question: "Track or ignore?", recommend: "ignore", options: CARD.options });

    const refused = await caller().inboxDecision({ id, decision: "accept", option: "skip" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe("CONFLICT");
    expect((refused as TRPCError).message).toMatch(/does not offer option "skip"/);

    expect(await caller().inboxDecision({ id, decision: "accept", option: "track" })).toMatchObject({ after: "accepted" });
  });
});

describe("inboxUnlinkWork", () => {
  it("is refused on a read-only server and reports nothing removed on an unlinked item", async () => {
    const { id } = await requestInboxItem(db, { externalId: `${KEY}-unlink`, title: "Ask", content: "x", metadata: { source: "slack" } });
    await expect(caller(true).inboxUnlinkWork({ id })).rejects.toThrow(/read-only/);
    expect(await caller().inboxUnlinkWork({ id })).toEqual({ id, removed: 0 });
    const [item] = (await caller().inbox({ statuses: ["pending"] })).items.filter((i) => i.id === id);
    expect(item?.about).toBeNull();
  });
});

describe("inboxRelease", () => {
  it("releases an undigested item and is refused on a read-only server", async () => {
    const { id } = await requestInboxItem(db, { externalId: `${KEY}-held`, title: "PR", content: "x", metadata: { source: "github", url: "https://github.com/a/b/pull/1" } });
    expect((await caller().inbox({ statuses: ["undigested"] })).items.some((i) => i.id === id)).toBe(true);
    await expect(caller(true).inboxRelease({ id })).rejects.toThrow(/read-only/);
    expect(await caller().inboxRelease({ id })).toMatchObject({ before: "undigested", after: "pending" });
  });

  it("records the context's client as the release's actor", async () => {
    const { id } = await requestInboxItem(db, { externalId: `${KEY}-held-phone`, title: "PR", content: "x", metadata: { source: "github", url: "https://github.com/a/b/pull/2" } });
    expect(await createCallerFactory(appRouter)({ db, client: "phone" }).inboxRelease({ id })).toMatchObject({ after: "pending" });
    // The procedure returns no run id; the released row names the run that wrote it.
    const [run] = await db
      .select({ actor: ingestRuns.actor, sourceSystem: ingestRuns.sourceSystem })
      .from(nodes)
      .innerJoin(ingestRuns, eq(ingestRuns.id, nodes.ingestRunId))
      .where(eq(nodes.id, id));
    expect(run).toEqual({ actor: "phone", sourceSystem: "human" });
  });
});

// tailnet-hosting decision 4: the admitted token client is the run's
// actor; without one, decisions stay `human` and request/complete keep
// core's own default.
describe("the actor an inbox write records", () => {
  async function actorsOf(ids: string[]): Promise<Map<string, { actor: string | null; sourceSystem: string }>> {
    const rows = await db.select({ id: ingestRuns.id, actor: ingestRuns.actor, sourceSystem: ingestRuns.sourceSystem }).from(ingestRuns).where(inArray(ingestRuns.id, ids));
    return new Map(rows.map((r) => [r.id, { actor: r.actor, sourceSystem: r.sourceSystem }]));
  }

  it("is the context's client on a decision, a request, and a completion", async () => {
    const phone = createCallerFactory(appRouter)({ db, client: "phone" });
    const requested = await phone.inboxRequest({ key: `${KEY}-actor-phone`, title: "Ask", content: "draft", metadata: { source: "session" } });
    const decided = await phone.inboxDecision({ id: requested.id, decision: "accept" });
    const completed = await phone.inboxComplete({ id: requested.id, note: "sent" });
    const actors = await actorsOf([requested.ingestRunId, decided.ingestRunId, completed.ingestRunId]);
    expect(actors.get(requested.ingestRunId)).toEqual({ actor: "phone", sourceSystem: "agent" });
    expect(actors.get(decided.ingestRunId)).toEqual({ actor: "phone", sourceSystem: "human" });
    expect(actors.get(completed.ingestRunId)).toEqual({ actor: "phone", sourceSystem: "agent" });
  });

  it("keeps today's actors with no client", async () => {
    const requested = await caller().inboxRequest({ key: `${KEY}-actor-local`, title: "Ask", content: "draft", metadata: { source: "session" } });
    const decided = await caller().inboxDecision({ id: requested.id, decision: "accept" });
    const completed = await caller().inboxComplete({ id: requested.id, note: "sent" });
    const actors = await actorsOf([requested.ingestRunId, decided.ingestRunId, completed.ingestRunId]);
    expect(actors.get(requested.ingestRunId)?.actor).toBe("inbox-cli");
    expect(actors.get(decided.ingestRunId)).toEqual({ actor: "human", sourceSystem: "human" });
    expect(actors.get(completed.ingestRunId)?.actor).toBe("inbox-cli");
  });
});

describe("inboxNotifyText", () => {
  it("names the chosen option", () => {
    const result = { id: "x", ingestRunId: "r", before: "pending" as const, after: "accepted" as const, title: "Batch", pane: null, socket: null };
    expect(inboxNotifyText(result, "", "track")).toMatch(/^\[inbox\] Accepted option track: "Batch"\./);
    expect(inboxNotifyText(result, "")).toMatch(/^\[inbox\] Accepted: "Batch"\./);
  });

  it("asks a session to triage a sent-back note into close, act, or re-queue", () => {
    const result = { id: "x", ingestRunId: "r", before: "pending" as const, after: "changes" as const, title: "Reply to Pat", pane: "p1", socket: null };
    const text = inboxNotifyText(result, "not for me, close it");
    expect(text).toMatch(/^\[inbox\] Sent to agent on "Reply to Pat": Note: not for me, close it/);
    expect(text).toContain('inbox done x "Closed on the note');
    expect(text).toMatch(/Act: .*inbox done x/);
    expect(text).toContain("re-queue with the same --key");
  });
});

describe("inbox sessions without herdr (tailnet-hosting decision 8)", () => {
  const SOCKET = "/tmp/inbox-router-herdr.sock";
  const noCalls: RunHerdrJson = async () => {
    throw new Error("herdr should not run");
  };

  it("refuses both session procedures naming herdr when it is missing from PATH, before the item is looked up", async () => {
    const missing = createCallerFactory(appRouter)({ db, herdrJson: noCalls, herdrSocket: SOCKET, missingBinaries: ["herdr"] });
    for (const call of [() => missing.inboxOpenSession({ id: randomUUID() }), () => missing.inboxFocusSession({ id: randomUUID() })]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
      expect((err as TRPCError).message).toBe("herdr is unavailable on this server: not found on PATH");
    }
  });

  it("maps a runner's HostBinaryUnavailableError to PRECONDITION_FAILED, not a failed or gone session", async () => {
    const { id } = await requestInboxItem(db, { externalId: `${KEY}-no-herdr`, title: "Ask", content: "x", metadata: { source: "slack" } });
    const gone: RunHerdrJson = async () => {
      throw new HostBinaryUnavailableError("herdr");
    };
    const opened = await createCallerFactory(appRouter)({ db, herdrJson: gone, herdrSocket: SOCKET }).inboxOpenSession({ id }).catch((e: unknown) => e);
    expect(opened).toMatchObject({ code: "PRECONDITION_FAILED", message: "herdr is unavailable on this server: not found on PATH" });

    const working: RunHerdrJson = async (args) => {
      const [group, verb] = args;
      if (group === "workspace" && verb === "list") return { workspaces: [] };
      if (group === "workspace" && verb === "create") return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
      return {};
    };
    await createCallerFactory(appRouter)({ db, herdrJson: working, herdrSocket: SOCKET, sessionCwd: "/tmp" }).inboxOpenSession({ id });
    const focused = await createCallerFactory(appRouter)({ db, herdrJson: gone, herdrSocket: SOCKET }).inboxFocusSession({ id }).catch((e: unknown) => e);
    expect(focused).toMatchObject({ code: "PRECONDITION_FAILED", message: "herdr is unavailable on this server: not found on PATH" });
  });
});

// hangar-queue decision 6: a session-bound token's item is told through the
// session's messages, never herdr; a pane item is prompted exactly as before.
describe("inbox delivery by where the item came from", () => {
  function herdrSpy(): { calls: (readonly string[])[]; runHerdr: (args: readonly string[], socket: string) => Promise<void> } {
    const calls: (readonly string[])[] = [];
    return { calls, runHerdr: async (args) => void calls.push(args) };
  }

  it("sends a session item's decision to its messages and never runs herdr, even if a pane got onto it", async () => {
    const session = await sessionNode("running");
    const worker = createCallerFactory(appRouter)({ db, client: `session-${session}`, scope: "agent", sessionId: session });
    const filed = await worker.inboxRequest({ key: `${KEY}-remote`, title: "Remote ask", content: "x", metadata: { source: "session", pane: "w1:p1", socket: "/tmp/herdr.sock", session: randomUUID() } });
    expect(filed.session).toBe(session);
    await db.execute(sql`UPDATE nodes SET metadata = metadata || '{"pane": "w1:p9", "socket": "/tmp/herdr.sock"}'::jsonb WHERE id = ${filed.id}::uuid`);

    const spy = herdrSpy();
    const decided = await createCallerFactory(appRouter)({ db, runHerdr: spy.runHerdr }).inboxDecision({ id: filed.id, decision: "accept", message: "ok" });
    expect(decided.notified).toEqual({ ok: true, session });
    expect(spy.calls).toEqual([]);
    const messages = await db.select({ kind: hangarMessages.kind, body: hangarMessages.body }).from(hangarMessages).where(eq(hangarMessages.sessionId, session));
    expect(messages).toEqual([{ kind: "inbox_decision", body: expect.objectContaining({ item_id: filed.id, decision: "accept", outcome: "accepted", message: "ok" }) }]);
  });

  it("refuses accept and send-back on a stopped session's item with CONFLICT, writes nothing, and runs no herdr", async () => {
    const session = await sessionNode("stopped");
    const worker = createCallerFactory(appRouter)({ db, client: `session-${session}`, scope: "agent", sessionId: session });
    const filed = await worker.inboxRequest({ key: `${KEY}-ended`, title: "Late ask", content: "x", metadata: { source: "session" } });
    // A pane got onto it anyway: an ended session's item is still not typed into one.
    await db.execute(sql`UPDATE nodes SET metadata = metadata || '{"pane": "w1:p9", "socket": "/tmp/herdr.sock"}'::jsonb WHERE id = ${filed.id}::uuid`);

    const spy = herdrSpy();
    const person = createCallerFactory(appRouter)({ db, runHerdr: spy.runHerdr });
    for (const decision of ["accept", "changes"] as const) {
      const refused = await person.inboxDecision({ id: filed.id, decision, message: "go" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TRPCError);
      expect((refused as TRPCError).code).toBe("CONFLICT");
      expect((refused as TRPCError).message).toBe("The hangar session that filed this has ended. Hand it off to a local session or dismiss it.");
    }
    expect(spy.calls).toEqual([]);
    expect(await db.select({ id: hangarMessages.id }).from(hangarMessages).where(eq(hangarMessages.sessionId, session))).toEqual([]);
    expect((await listInbox(db, { ids: [filed.id] })).items[0]).toMatchObject({ status: "pending", hangarSession: session, feedback: [] });

    // Dismiss still works: it tells the person nobody was reached, and clears the session.
    const dismissed = await person.inboxDecision({ id: filed.id, decision: "dismiss" });
    expect(dismissed.notified).toEqual({ ok: false, reason: "the hangar session that filed it has ended" });
    expect(dismissed).toMatchObject({ session: null, endedSession: session, after: "dismissed" });
    expect(spy.calls).toEqual([]);
    expect((await listInbox(db, { ids: [filed.id], statuses: ["dismissed"] })).items[0]?.hangarSession).toBeNull();
  });

  it("hands a stopped session's item to a local session, sending nothing and clearing the session", async () => {
    const session = await sessionNode("stopped");
    const worker = createCallerFactory(appRouter)({ db, client: `session-${session}`, scope: "agent", sessionId: session });
    const filed = await worker.inboxRequest({ key: `${KEY}-ended-handoff`, title: "Late deep one", content: "x", metadata: { source: "session" } });
    const promptFiles: string[] = [];
    const herdrJson = async (args: readonly string[]): Promise<Record<string, unknown>> => {
      if (args[0] === "agent" && args[1] === "start") promptFiles.push(...args.flatMap((a) => /^Read (\S+) and do what it says\.$/.exec(a)?.[1] ?? []));
      return { workspaces: [], workspace: { workspace_id: "w5" }, tab: { tab_id: "w5:t2" }, root_pane: { pane_id: "w5:p2" } };
    };
    try {
      const opened = await createCallerFactory(appRouter)({ db, herdrJson, herdrSocket: "/tmp/server-herdr.sock" }).inboxOpenSession({ id: filed.id });
      expect(opened).toMatchObject({ tab: "w5:t2", pane: "w5:p2" });
    } finally {
      await Promise.all(promptFiles.map((f) => rm(f, { force: true })));
    }
    expect(await db.select({ id: hangarMessages.id }).from(hangarMessages).where(eq(hangarMessages.sessionId, session))).toEqual([]);
    expect((await listInbox(db, { ids: [filed.id], statuses: ["session"] })).items[0]).toMatchObject({ hangarSession: null, pane: "w5:p2" });
  });

  it("prompts a pane item's session through herdr as before", async () => {
    const filed = await caller().inboxRequest({ key: `${KEY}-pane`, title: "Pane ask", content: "x", metadata: { source: "session", pane: "w1:p4", socket: "/tmp/herdr.sock" } });
    expect(filed.session).toBeNull();
    const spy = herdrSpy();
    const decided = await createCallerFactory(appRouter)({ db, runHerdr: spy.runHerdr }).inboxDecision({ id: filed.id, decision: "dismiss" });
    expect(decided.notified).toEqual({ ok: true, pane: "w1:p4" });
    expect(spy.calls).toEqual([["agent", "prompt", "w1:p4", inboxNotifyText({ id: filed.id, title: "Pane ask", after: "dismissed" }, "")]]);
  });

  it("refuses inboxComplete from a session token on another session's item with FORBIDDEN", async () => {
    const mine = await sessionNode("running");
    const other = await sessionNode("running");
    const worker = (session: string) => createCallerFactory(appRouter)({ db, client: `session-${session}`, scope: "agent", sessionId: session });
    const filed = await worker(mine).inboxRequest({ key: `${KEY}-complete`, title: "Finish", content: "x", metadata: { source: "session" } });
    await caller().inboxDecision({ id: filed.id, decision: "accept" });
    const refused = await worker(other).inboxComplete({ id: filed.id, note: "not mine" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe("FORBIDDEN");
    expect(await worker(mine).inboxComplete({ id: filed.id, note: "done" })).toMatchObject({ id: filed.id });
  });
});

// laptop-relay decision 6: without herdr, a pane item's prompt is queued for
// the laptop relay; a session item is told through its messages as before.
describe("inbox delivery without herdr (queued for the laptop relay)", () => {
  const noHerdr: (args: readonly string[], socket: string) => Promise<void> = async () => {
    throw new Error("herdr should not run");
  };

  it("queues the pane's prompt as a herdr_prompt action and reports its id", async () => {
    const filed = await caller().inboxRequest({ key: `${KEY}-relay-pane`, title: "Relay ask", content: "x", metadata: { source: "session", pane: "w1:p6", socket: "/Users/someone/.config/herdr/herdr.sock" } });
    const decided = await createCallerFactory(appRouter)({ db, runHerdr: noHerdr, missingBinaries: ["herdr"], client: "phone-2" }).inboxDecision({ id: filed.id, decision: "accept", message: "go ahead" });
    expect(decided.notified).toEqual({ ok: true, relay: expect.any(Number) });
    const actionId = (decided.notified as { relay: number }).relay;
    ACTION_IDS.push(actionId);
    expect(await getRelayAction(db, actionId)).toMatchObject({
      kind: "herdr_prompt",
      state: "queued",
      requestedBy: "phone-2",
      originNodeId: filed.id,
      payload: { pane: "w1:p6", socket: "/Users/someone/.config/herdr/herdr.sock", text: inboxNotifyText({ id: filed.id, title: "Relay ask", after: "accepted" }, "go ahead") },
    });
  });

  it("queues the prompt for a near-limit note and title whole, within the relay payload's cap (core fitRelayHerdrText cuts anything longer)", async () => {
    const herdrless = createCallerFactory(appRouter)({ db, runHerdr: noHerdr, missingBinaries: ["herdr"] });
    const note = `${"n".repeat(MAX_INBOX_FEEDBACK_LENGTH - 4)} end`;
    const near = await caller().inboxRequest({ key: `${KEY}-relay-near`, title: "t".repeat(500), content: "x", metadata: { source: "session", pane: "w1:p6", socket: "/tmp/herdr.sock" } });
    const fits = await herdrless.inboxDecision({ id: near.id, decision: "changes", message: note });
    const fitsId = (fits.notified as { relay: number }).relay;
    ACTION_IDS.push(fitsId);
    const whole = inboxNotifyText({ id: near.id, title: "t".repeat(500), after: "changes" }, note);
    expect(whole.length).toBeLessThanOrEqual(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH);
    expect((await getRelayAction(db, fitsId))?.payload).toMatchObject({ text: whole });
  });

  it("reports an action it could not queue as not notified, and still records the decision", async () => {
    const filed = await caller().inboxRequest({ key: `${KEY}-relay-fail`, title: "Relay fail", content: "x", metadata: { source: "session", pane: "w1:p7", socket: "/tmp/herdr.sock" } });
    // The queue is down; the decision's own writes (in their transaction) are not.
    const queueDown = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "execute") return Reflect.get(target, key, receiver);
        return (query: { queryChunks?: unknown[] }) => {
          const text = (query.queryChunks ?? []).map((c) => (c !== null && typeof c === "object" && Array.isArray((c as { value?: unknown }).value) ? (c as { value: string[] }).value.join("") : "")).join("");
          if (text.includes("INSERT INTO relay_actions")) return Promise.reject(new Error("relay queue unavailable"));
          return target.execute(query as never);
        };
      },
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const decided = await createCallerFactory(appRouter)({ db: queueDown, runHerdr: noHerdr, missingBinaries: ["herdr"] }).inboxDecision({ id: filed.id, decision: "dismiss" });
      expect(decided.notified).toEqual({ ok: false, reason: "could not queue the notification" });
      expect(decided.after).toBe("dismissed");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });

  it("still sends a session item's decision to its messages, queuing nothing", async () => {
    const session = await sessionNode("running");
    const worker = createCallerFactory(appRouter)({ db, client: `session-${session}`, scope: "agent", sessionId: session });
    const filed = await worker.inboxRequest({ key: `${KEY}-relay-remote`, title: "Remote ask", content: "x", metadata: { source: "session" } });
    await db.execute(sql`UPDATE nodes SET metadata = metadata || '{"pane": "w1:p9", "socket": "/tmp/herdr.sock"}'::jsonb WHERE id = ${filed.id}::uuid`);
    const decided = await createCallerFactory(appRouter)({ db, runHerdr: noHerdr, missingBinaries: ["herdr"] }).inboxDecision({ id: filed.id, decision: "accept", message: "ok" });
    expect(decided.notified).toEqual({ ok: true, session });
    expect(await db.select({ id: relayActions.id }).from(relayActions).where(eq(relayActions.originNodeId, filed.id))).toEqual([]);
  });

  it("prompts through herdr directly and queues nothing when herdr is on PATH", async () => {
    const filed = await caller().inboxRequest({ key: `${KEY}-relay-direct`, title: "Direct ask", content: "x", metadata: { source: "session", pane: "w1:p8", socket: "/tmp/herdr.sock" } });
    const calls: (readonly string[])[] = [];
    const decided = await createCallerFactory(appRouter)({ db, runHerdr: async (args) => void calls.push(args) }).inboxDecision({ id: filed.id, decision: "dismiss" });
    expect(decided.notified).toEqual({ ok: true, pane: "w1:p8" });
    expect(calls).toHaveLength(1);
    expect(await db.select({ id: relayActions.id }).from(relayActions).where(eq(relayActions.originNodeId, filed.id))).toEqual([]);
  });
});
