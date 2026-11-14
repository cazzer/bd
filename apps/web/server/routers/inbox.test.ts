import { randomUUID } from "node:crypto";
import { HostBinaryUnavailableError, requestInboxItem } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../router.js";
import type { RunHerdrJson } from "../herdr-session.js";
import { createCallerFactory } from "../trpc.js";
import { inboxNotifyText } from "./inbox.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
const KEY = `session:inbox-router-${randomUUID().slice(0, 8)}`;
const CARD = { question: "Track or ignore?", options: [{ id: "track", label: "Track" }, { id: "ignore", label: "Ignore" }], recommend: "ignore" };

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), like(nodes.externalId, `${KEY}%`)));
  await pool.end();
});

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
