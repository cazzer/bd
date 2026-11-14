// `hangarStatus` over the real router and database (hangar-queue design
// decision 7). The database is shared with live data and with suites that
// check hangar in in parallel, so this asserts the shape and the rules that
// hold whichever hangar checked in last, never a particular liveness state.

import { randomUUID } from "node:crypto";
import { recordCheckIn } from "@breakdown/core";
import { createDb, createPool, hangarCheckIns, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

const HANGAR = `test-hgstatus-${randomUUID().slice(0, 8)}`;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

let pool: ReturnType<typeof createPool>;
let db: Database;
const caller = (scope: Context["scope"]) => createCallerFactory(appRouter)({ db, scope });

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await db.delete(hangarCheckIns).where(eq(hangarCheckIns.hangar, HANGAR));
  await pool.end();
});

describe("hangarStatus", () => {
  it("answers liveness, the last hangar, and the open counts with ISO times from the server's clock", async () => {
    await recordCheckIn(db, { hangar: HANGAR, version: "9.9.9" });
    const status = await caller("agent").hangarStatus();
    expect(Object.keys(status).sort()).toEqual(["claimed", "hangar", "intervalS", "lastSeenAt", "now", "queued", "running", "status", "version"]);
    // A check-in just landed, so some hangar has checked in recently.
    expect(status.status).toBe("online");
    expect(status.hangar).toEqual(expect.any(String));
    expect(status.lastSeenAt).toMatch(ISO);
    expect(status.now).toMatch(ISO);
    expect(Date.parse(status.now)).toBeGreaterThanOrEqual(Date.parse(status.lastSeenAt!));
    expect(status.intervalS).toBe(30);
    for (const n of [status.queued, status.claimed, status.running]) expect(Number.isInteger(n) && n >= 0).toBe(true);
  });

  it("serves the local person too, and refuses a hangar token", async () => {
    expect((await caller(null).hangarStatus()).now).toMatch(ISO);
    await expect(caller("hangar").hangarStatus()).rejects.toBeInstanceOf(TRPCError);
  });
});
