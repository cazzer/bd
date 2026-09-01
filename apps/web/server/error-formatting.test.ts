// bd-hmd.3 review, priority 1: prove `cause`, stack traces, and SQL text
// never reach a response — this is the regression guard the review asked
// for, because a future edit that spreads `shape.data` (`data: {
// ...shape.data }` instead of the field-by-field rebuild in trpc.ts)
// would silently reintroduce the leak with no other signal.
//
// Tests `buildSafeErrorShape` directly (no HTTP server, no database) —
// see trpc.ts's header for why that function was pulled out of the
// inline `errorFormatter` callback specifically to make this possible.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSafeErrorShape } from "./trpc.js";

describe("buildSafeErrorShape", () => {
  it("never forwards shape.data.stack, even when the input shape carries one (tRPC's own default shape includes this outside production NODE_ENV)", () => {
    const shape = {
      code: -32603,
      message: "getNodes query failed (postgres: 42P01) This is a database problem, not a problem with your input — you may retry.",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        path: "getNodes",
        // Simulates what tRPC's own defaultFormatter attaches outside
        // production NODE_ENV — an internal file path and line number.
        stack: "TRPCError: getNodes query failed\n    at /Users/caleb/dev/bd/apps/web/server/errors.ts:145:12\n    at processProcedure",
      } as Record<string, unknown> as { code: string; httpStatus: number; path?: string },
    };

    const result = buildSafeErrorShape(shape, { code: "INTERNAL_SERVER_ERROR" });

    expect(result.data).not.toHaveProperty("stack");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/Users/caleb/dev/bd");
    expect(serialized).not.toContain("errors.ts:145");
  });

  it("never forwards error.cause, even when it embeds a full SQL statement (LookupFailedError's real hazard — drizzle-orm's DrizzleQueryError.message is 'Failed query: <sql>\\nparams: ...')", () => {
    const fakeSql = "select * from nodes n /* secret internal comment nobody should see */ where n.id = $1";
    const driverErr = new Error(`Failed query: ${fakeSql}\nparams: 42`);

    const shape = {
      code: -32603,
      message: "getNodes query failed (postgres: 42P01) This is a database problem, not a problem with your input — you may retry.",
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "getNodes" },
    };

    const result = buildSafeErrorShape(shape, { code: "INTERNAL_SERVER_ERROR", cause: driverErr });

    expect(result).not.toHaveProperty("cause");
    expect(result.data).not.toHaveProperty("cause");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("select * from nodes");
    expect(serialized).not.toContain("secret internal comment");
    expect(serialized).not.toContain("Failed query");
  });

  it("never forwards a DATABASE_URL-shaped value that ends up as error.cause", () => {
    const leaky = new Error("connect ECONNREFUSED postgres://breakdown:hunter2@localhost:5442/breakdown");

    const shape = {
      code: -32603,
      message: "database at localhost:5442/breakdown is unreachable This is a server-side problem, not something in your input to fix. You may retry.",
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "search" },
    };

    const result = buildSafeErrorShape(shape, { code: "INTERNAL_SERVER_ERROR", cause: leaky });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("postgres://");
  });

  it("flattens a real Zod input-validation failure into field:message text, and still omits stack/cause", () => {
    const parsed = z.object({ query: z.string().min(1, "must not be empty") }).safeParse({ query: "" });
    if (parsed.success) throw new Error("expected this parse to fail");

    const shape = {
      code: -32600,
      message: "Invalid input",
      data: { code: "BAD_REQUEST", httpStatus: 400, path: "search" },
    };

    const result = buildSafeErrorShape(shape, { code: "BAD_REQUEST", cause: parsed.error });

    expect(result.message).toBe("Invalid input: query: must not be empty");
    expect(result.data).not.toHaveProperty("stack");
    expect(result).not.toHaveProperty("cause");
  });

  it("passes through a plain KnowledgeStoreError-mapped message unchanged when there is no Zod cause", () => {
    const shape = {
      code: -32600,
      message: 'node abc/def (batch index 0) has a title of length 100, which exceeds the maximum of 10 (see UpsertNodesOptions.maxTitleLength) title must be at most 500 characters',
      data: { code: "BAD_REQUEST", httpStatus: 400, path: "createNote" },
    };

    const result = buildSafeErrorShape(shape, { code: "BAD_REQUEST" });

    expect(result.message).toBe(shape.message);
    expect(result.data).toEqual({ code: "BAD_REQUEST", httpStatus: 400, path: "createNote" });
  });
});
