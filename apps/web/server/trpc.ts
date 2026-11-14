// tRPC instance (bd-hmd.3): context type, procedure/router builders, and a
// deliberately-configured error formatter.
//
// Never the default formatter: tRPC's built-in error shape can include a
// `stack` in non-production `NODE_ENV` (an internal file path/line into
// this server) and would happily echo back whatever `cause` a call site
// attached to the underlying error. Neither ever reaches the wire here —
// `data` below is built field-by-field, never spread from `shape.data`,
// so there is no path for a `stack` or `cause` to ride along even if a
// future change to error.ts's `mapCoreError` started attaching one. See
// errors.ts's header for the concrete hazard this guards against
// (`LookupFailedError.cause` embeds a full SQL statement).
//
// `buildSafeErrorShape` below is the actual shaping logic, deliberately
// pulled out of the inline `errorFormatter` callback so it is directly
// unit-testable (error-formatting.test.ts) without spinning up a tRPC
// server or a database — that test is the regression guard the bd-hmd.3
// review asked for: "a future edit spreading shape.data would silently
// reintroduce the leak."
//
// Every procedure declares the token scopes it accepts (hangar-queue
// decision 5): routers build on `humanProcedure` or `agentProcedure`, never
// on `t.procedure`, and `scopeGate` refuses any admitted scope outside the
// declaration with FORBIDDEN. A tokenless request (loopback) counts as
// `human`. A procedure with no declared scopes is refused for everyone, and
// procedure-scopes.test.ts fails on one, so a new procedure has to choose.
// The gate runs before input parsing, so a refused call is never validated.

import { initTRPC, TRPCError } from "@trpc/server";
import type { ClientTokenScope } from "@breakdown/db";
import { ZodError } from "zod";
import type { Context } from "./context.js";

/** Per-procedure metadata: the token scopes a procedure accepts (module header). */
export interface ProcedureMeta {
  scopes?: readonly ClientTokenScope[];
}

/** Flattens a Zod input-validation failure into `field: message` pairs — mirrors apps/mcp/src/errors.ts's formatZodError. */
function formatZodIssues(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");
}

/** The minimal slice of tRPC's computed default shape this function reads — see buildSafeErrorShape. */
export interface RawErrorShape {
  code: number;
  message: string;
  data: {
    code: string;
    httpStatus: number;
    path?: string;
  };
}

/** The minimal slice of the underlying `TRPCError` this function reads. */
export interface RawErrorInfo {
  code: string;
  cause?: unknown;
}

/**
 * Rebuilds the error shape actually sent to the client: a Zod
 * input-validation failure (`error.cause instanceof ZodError`) is
 * flattened into readable `field: message` text; every other error keeps
 * `shape.message` (already safe — built by `mapCoreError` from nothing
 * but a `KnowledgeStoreError`'s own `.message`, see errors.ts). `data` is
 * always rebuilt field-by-field — `code`, `httpStatus`, `path` only —
 * never spread from `shape.data`, so a `stack` tRPC's own default shape
 * carries in non-production `NODE_ENV`, or a `cause` a call site
 * mistakenly attached, has no path onto the wire regardless of what
 * either object actually contains.
 */
export function buildSafeErrorShape(shape: RawErrorShape, error: RawErrorInfo): RawErrorShape {
  const zodCause = error.code === "BAD_REQUEST" && error.cause instanceof ZodError ? error.cause : null;

  return {
    code: shape.code,
    message: zodCause ? `Invalid input: ${formatZodIssues(zodCause)}` : shape.message,
    data: {
      code: shape.data.code,
      httpStatus: shape.data.httpStatus,
      path: shape.data.path,
      // Deliberately omitted: `stack`, `cause`. See module header.
    },
  };
}

const t = initTRPC.context<Context>().meta<ProcedureMeta>().create({
  // SSE keep-alive for the live board's subscription: the server pings so
  // idle proxies keep the stream open, and the client treats 45 s of
  // silence as a dead stream and reconnects (the board re-reads on reconnect).
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 45_000 } },
  errorFormatter: ({ shape, error }) => buildSafeErrorShape(shape, error),
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;

const scopeGate = t.middleware(({ ctx, meta, path, next }) => {
  const scope = ctx.scope ?? "human";
  if (meta?.scopes?.includes(scope) !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${/^[aeiou]/.test(scope) ? "An" : "A"} ${scope} token cannot call ${path}.` });
  }
  return next();
});

const gated = t.procedure.use(scopeGate);
/** A person's procedures: decisions, edits, and every read the agent tools don't need. */
export const humanProcedure = gated.meta({ scopes: ["human"] });
/** Also open to `agent` tokens: filing and completing inbox requests, and the reads the inbox scripts use. */
export const agentProcedure = gated.meta({ scopes: ["human", "agent"] });
/** For building a server-side caller — used by tests (routers/write.test.ts) to call procedures directly without an HTTP round trip. */
export const createCallerFactory = t.createCallerFactory;
export { TRPCError };
