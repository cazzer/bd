// Every tRPC procedure declares the token scopes it accepts (hangar-queue
// decision 5, trpc.ts header). The enumeration is the guard: a procedure
// added without `humanProcedure` or `agentProcedure` fails here, and the
// agent set is pinned so widening it is a visible, reviewed change. No
// database: the gate refuses before any handler or input parser runs.

import type { Database } from "@breakdown/db";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";
import { createCallerFactory, type ProcedureMeta } from "./trpc.js";

const procedures = Object.entries(appRouter._def.procedures as Record<string, { _def: { meta?: ProcedureMeta } }>);
const scopesOf = (name: string): readonly string[] => procedures.find(([path]) => path === name)?.[1]._def.meta?.scopes ?? [];

const AGENT_PROCEDURES = ["beadsProjects", "hangarStatus", "inbox", "inboxComplete", "inboxRequest"];

const caller = (scope: Context["scope"]) => createCallerFactory(appRouter)({ db: {} as Database, scope });

async function refusal(call: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await call();
  } catch (err) {
    if (err instanceof TRPCError) return err;
    throw err;
  }
  throw new Error("the call was not refused");
}

describe("procedure scopes", () => {
  it("finds the router's procedures", () => {
    expect(procedures.length).toBeGreaterThan(30);
  });

  it("declares a non-empty scope list on every procedure", () => {
    const undeclared = procedures.filter(([, procedure]) => (procedure._def.meta?.scopes ?? []).length === 0).map(([path]) => path);
    expect(undeclared).toEqual([]);
  });

  it("opens exactly the inbox scripts' procedures to agent tokens", () => {
    const agent = procedures.filter(([path]) => scopesOf(path).includes("agent")).map(([path]) => path);
    expect(agent.sort()).toEqual(AGENT_PROCEDURES);
  });

  it("keeps every procedure open to a person", () => {
    expect(procedures.filter(([path]) => !scopesOf(path).includes("human")).map(([path]) => path)).toEqual([]);
  });

  it("opens no procedure to a hangar token", () => {
    expect(procedures.filter(([path]) => scopesOf(path).includes("hangar")).map(([path]) => path)).toEqual([]);
  });

  it("refuses an agent caller on a person's procedure with FORBIDDEN before validating its input", async () => {
    const agent = caller("agent");
    const createNote = await refusal(() => agent.createNote({ title: "", content: "" } as never));
    expect(createNote).toMatchObject({ code: "FORBIDDEN", message: "An agent token cannot call createNote." });
    const decide = await refusal(() => agent.inboxDecision({} as never));
    expect(decide).toMatchObject({ code: "FORBIDDEN", message: "An agent token cannot call inboxDecision." });
  });

  it("lets a tokenless caller (the local person) past the gate, to input validation", async () => {
    for (const scope of [null, undefined, "human"] as const) {
      expect(await refusal(() => caller(scope).createNote(42 as never)), String(scope)).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await refusal(() => caller("agent").inboxComplete(42 as never))).toMatchObject({ code: "BAD_REQUEST" });
  });
});
