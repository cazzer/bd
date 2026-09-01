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

import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import type { Context } from "./context.js";

/** Flattens a Zod input-validation failure into `field: message` pairs — mirrors apps/mcp/src/errors.ts's formatZodError. */
function formatZodIssues(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
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
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
export { TRPCError };
