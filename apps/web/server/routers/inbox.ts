// The inbox (inbox.ts in core): the queue read and the person's decision.
// Deciding is a pure Postgres write — it records the decision and moves the
// item to the next turn (accepted → the executor session's, changes → the
// agent's). Nothing here runs a command or calls a model.

import { decideInboxItem, INBOX_DECISIONS, INBOX_STATUSES, listInbox, MAX_INBOX_FEEDBACK_LENGTH, type InboxItem } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

export interface InboxItemDto extends Omit<InboxItem, "receivedAt" | "updatedAt"> {
  receivedAt: string;
  updatedAt: string;
}

function toDto(item: InboxItem): InboxItemDto {
  return { ...item, receivedAt: item.receivedAt.toISOString(), updatedAt: item.updatedAt.toISOString() };
}

export const inboxInputSchema = z
  .object({
    statuses: z.array(z.enum(INBOX_STATUSES)).max(INBOX_STATUSES.length).optional(),
  })
  .optional();

const inboxProcedure = publicProcedure.input(inboxInputSchema).query(async ({ ctx, input }) => {
  try {
    const list = await listInbox(ctx.db, input?.statuses === undefined ? {} : { statuses: input.statuses });
    return { items: list.items.map(toDto), total: list.total, truncated: list.truncated };
  } catch (err) {
    throw mapCoreError("inbox", err);
  }
});

// eslint-disable-next-line no-control-regex
const REFUSED_MESSAGE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export const inboxDecisionInputSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(INBOX_DECISIONS),
  message: z
    .string()
    .refine((m) => !REFUSED_MESSAGE_CHARS.test(m), "must not contain control characters (other than newline and tab) or bidirectional override characters")
    .max(MAX_INBOX_FEEDBACK_LENGTH)
    .default(""),
});

const inboxDecisionProcedure = publicProcedure.input(inboxDecisionInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); inbox decisions are refused." });
  }
  try {
    return await decideInboxItem(ctx.db, input.id, { decision: input.decision, message: input.message });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
});

export const inboxRouter = router({
  inbox: inboxProcedure,
  inboxDecision: inboxDecisionProcedure,
});
