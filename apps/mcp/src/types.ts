// Shared shapes for the tool layer. Kept separate from server.ts so
// tools/*.ts never needs to import the SDK's low-level Server type.

import type { Database } from "@breakdown/db";
import type { z } from "zod";

export interface ToolContext {
  db: Database;
  /** Character budget for a single tool response's JSON payload — see budget.ts. */
  responseCharBudget: number;
}

/**
 * One MCP tool: its name, description (shown to the model), Zod argument
 * schema (validated by server.ts before the handler ever runs — no tool
 * handler sees unvalidated input), whether it mutates the store (drives
 * read-only gating in server.ts), and the handler itself.
 *
 * Handlers are thin: parse is already done by the time they run, they
 * call exactly one or two `@breakdown/core` functions, and shape the
 * result. All business logic — validation, merge folding, batching,
 * attribution — lives in `@breakdown/core`, not here.
 */
export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: Schema;
  isWrite: boolean;
  handler: (ctx: ToolContext, args: z.infer<Schema>) => Promise<Record<string, unknown>>;
}
