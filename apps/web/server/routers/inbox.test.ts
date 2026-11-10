import { randomUUID } from "node:crypto";
import { requestInboxItem } from "@breakdown/core";
import { createDb, createPool, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../router.js";
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
