// `relayStatus` and `relayAction` over the real router and database
// (laptop-relay design.md decisions 8 and 9). The database is shared with
// live data and with suites that check a relay in or queue actions in
// parallel, so status is asserted by shape and rule, never by a particular
// liveness or count; actions are this file's own, queued with its own
// project key and deleted by id. Nothing here claims an action.

import { randomUUID } from "node:crypto";
import { enqueueRelayAction, recordRelayCheckIn, reportRelayAction, claimRelayAction } from "@breakdown/core";
import { createDb, createPool, relayActions, relayCheckIns, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

const TAG = randomUUID().slice(0, 8);
const RELAY = `test-rlstatus-${TAG}`;
const PROJECT = `rls-${TAG}`;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

let pool: ReturnType<typeof createPool>;
let db: Database;
const ACTION_IDS: number[] = [];
const caller = (over: Partial<Context> = {}) => createCallerFactory(appRouter)({ db, ...over });

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  if (ACTION_IDS.length > 0) await db.delete(relayActions).where(inArray(relayActions.id, ACTION_IDS));
  await db.delete(relayCheckIns).where(eq(relayCheckIns.relay, RELAY));
  await pool.end();
});

describe("relayStatus", () => {
  it("answers liveness, the last relay, the open counts, and the server's missing binaries, with ISO times from its clock", async () => {
    await recordRelayCheckIn(db, { relay: RELAY, version: "9.9.9" });
    const status = await caller({ missingBinaries: ["bd", "herdr"] }).relayStatus();
    expect(Object.keys(status).sort()).toEqual(["claimed", "intervalS", "lastSeenAt", "missingBinaries", "now", "queued", "relay", "status", "version"]);
    // A check-in just landed, so some relay has checked in recently.
    expect(status.status).toBe("online");
    expect(status.relay).toEqual(expect.any(String));
    expect(status.lastSeenAt).toMatch(ISO);
    expect(status.now).toMatch(ISO);
    expect(status.missingBinaries).toEqual(["bd", "herdr"]);
    for (const n of [status.queued, status.claimed]) expect(Number.isInteger(n) && n >= 0).toBe(true);
  });

  it("reports no missing binaries on a server that has both", async () => {
    expect((await caller().relayStatus()).missingBinaries).toEqual([]);
  });

  it("refuses an agent token", async () => {
    await expect(caller({ scope: "agent" }).relayStatus()).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("relayAction", () => {
  it("serves a queued action's state, then its result once reported, without its payload", async () => {
    const { action } = await enqueueRelayAction(db, { kind: "beads_reingest", payload: { project_key: PROJECT }, requestedBy: "relay-router-suite" });
    ACTION_IDS.push(action.id);

    const queued = await caller().relayAction({ id: action.id });
    expect(queued).toEqual({ id: action.id, kind: "beads_reingest", state: "queued", result: null, error: null, createdAt: expect.stringMatching(ISO), finishedAt: null });

    // Claimed only among this file's own action, so no live action is touched.
    const claimed = await claimRelayAction(db, { relay: RELAY, among: [action.id] });
    expect(claimed?.id).toBe(action.id);
    expect((await caller().relayAction({ id: action.id })).state).toBe("claimed");

    await reportRelayAction(db, { relay: RELAY, id: action.id, state: "done", result: { note: "already applied" } });
    expect(await caller().relayAction({ id: action.id })).toMatchObject({ state: "done", result: { note: "already applied" }, finishedAt: expect.stringMatching(ISO) });
  });

  it("answers NOT_FOUND for an id with no action, and BAD_REQUEST for a malformed one", async () => {
    await expect(caller().relayAction({ id: 999_999_999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().relayAction({ id: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().relayAction({ id: 1.5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an agent or relay token", async () => {
    for (const scope of ["agent", "relay"] as const) await expect(caller({ scope }).relayAction({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
