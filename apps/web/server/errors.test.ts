// bd-hmd.3 review, priority 1 (continued): mapCoreError is the other half
// of the leak-prevention chain — see error-formatting.test.ts for the
// tRPC-formatter half, and errors.ts's header for the concrete hazard
// (LookupFailedError.cause embeds a full SQL statement via drizzle-orm's
// DrizzleQueryError).

import { EdgeUpsertFailedError, InvalidEventTimeError, InvalidListOptionError, InvalidViewError, LookupFailedError } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import { mapCoreError } from "./errors.js";

describe("mapCoreError", () => {
  it("maps InvalidViewError to BAD_REQUEST naming the item and field (node-views)", () => {
    const coreErr = new InvalidViewError("at batch index 1 (agent/kanban-view)", "renderer", "kanban", "must be one of graph, feed, code, timeline, board");
    const trpcErr = mapCoreError("createView", coreErr);

    expect(trpcErr.code).toBe("BAD_REQUEST");
    expect(trpcErr.message).toContain("at batch index 1 (agent/kanban-view)");
    expect(trpcErr.message).toContain('renderer (got "kanban")');
    expect(trpcErr.message).toContain("graph, feed, code, timeline, board");
    expect(trpcErr.cause).toBeUndefined();
  });

  it("maps InvalidEventTimeError to BAD_REQUEST naming the item and occurred_at, with the canonical form in the hint (timeline-view)", () => {
    const coreErr = new InvalidEventTimeError("at batch index 0 (agent/late)", "last Tuesday", "must parse as an instant");
    const trpcErr = mapCoreError("write", coreErr);

    expect(trpcErr.code).toBe("BAD_REQUEST");
    expect(trpcErr.message).toContain("at batch index 0 (agent/late)");
    expect(trpcErr.message).toContain('occurred_at (got "last Tuesday")');
    expect(trpcErr.message).toContain("2026-03-04T08:00:00.000Z");
    expect(trpcErr.cause).toBeUndefined();
  });

  it("maps InvalidListOptionError to BAD_REQUEST naming the option (list)", () => {
    const coreErr = new InvalidListOptionError("cursor", { updatedAt: "yesterday", id: "x" }, "must be a nextCursor from a previous listNodes result");
    const trpcErr = mapCoreError("list", coreErr);

    expect(trpcErr.code).toBe("BAD_REQUEST");
    expect(trpcErr.message).toContain("cursor");
    expect(trpcErr.cause).toBeUndefined();
  });

  it("never reads or forwards a KnowledgeStoreError's .cause, even when it embeds a full SQL statement", () => {
    const fakeSql = "select * from nodes n /* secret internal comment */ where n.id = $1";
    const driverErr = new Error(`Failed query: ${fakeSql}\nparams: 42`);
    const coreErr = new LookupFailedError("getNodes query failed (postgres: 42P01)", "getNodes", { cause: driverErr });

    const trpcErr = mapCoreError("getNodes", coreErr);

    expect(trpcErr.cause).toBeUndefined();
    expect(trpcErr.message).not.toContain("select * from nodes");
    expect(trpcErr.message).not.toContain("secret internal comment");
    const serialized = JSON.stringify(trpcErr, Object.getOwnPropertyNames(trpcErr));
    expect(serialized).not.toContain("select * from nodes");
    expect(serialized).not.toContain("secret internal comment");
  });

  it("maps LookupFailedError to INTERNAL_SERVER_ERROR with a retry hint, message naming only what core already named", () => {
    const coreErr = new LookupFailedError("getNodes query failed (postgres: 42P01)", "getNodes");
    const trpcErr = mapCoreError("getNodes", coreErr);

    expect(trpcErr.code).toBe("INTERNAL_SERVER_ERROR");
    expect(trpcErr.message).toContain("getNodes query failed");
    expect(trpcErr.message).toContain("retry");
  });

  it("maps an EdgeUpsertFailedError wrapping a foreign-key violation to BAD_REQUEST naming the bad ids, not a generic retry hint (mirrors apps/mcp's identical fix)", () => {
    const pgErr = Object.assign(new Error("insert or update on table \"edges\" violates foreign key constraint"), {
      code: "23503",
      constraint: "edges_src_id_nodes_id_fk",
    });
    const coreErr = new EdgeUpsertFailedError("edge ... failed to write", 0, 0, { cause: pgErr });

    const trpcErr = mapCoreError("assertEdge", coreErr);

    expect(trpcErr.code).toBe("BAD_REQUEST");
    expect(trpcErr.message).toContain("do not reference an existing node");
    expect(trpcErr.message).not.toContain("database problem");
  });

  it("maps an EdgeUpsertFailedError wrapping a non-foreign-key failure to INTERNAL_SERVER_ERROR with the retry hint", () => {
    const pgErr = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const coreErr = new EdgeUpsertFailedError("edge ... failed to write", 0, 0, { cause: pgErr });

    const trpcErr = mapCoreError("assertEdge", coreErr);

    expect(trpcErr.code).toBe("INTERNAL_SERVER_ERROR");
    expect(trpcErr.message).toContain("retry");
  });

  it("maps a truly unrecognized error to a fixed generic INTERNAL_SERVER_ERROR message, never echoing the raw error's own message", () => {
    const raw = new Error("connect ECONNREFUSED postgres://breakdown:hunter2@localhost:5442/breakdown");

    const trpcErr = mapCoreError("search", raw);

    expect(trpcErr.code).toBe("INTERNAL_SERVER_ERROR");
    expect(trpcErr.message).not.toContain("hunter2");
    expect(trpcErr.message).not.toContain("postgres://");
    expect(trpcErr.message).not.toContain("ECONNREFUSED");
    expect(trpcErr.message).toContain("search failed unexpectedly");
  });
});
