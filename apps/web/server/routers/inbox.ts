// The inbox (inbox.ts in core): the queue read and the person's decision.
// Deciding is a pure Postgres write — it records the decision and moves the
// item to the next turn (accepted → the executor session's, changes → the
// agent's). Nothing here runs a command or calls a model.

import {
  completeInboxItem,
  decideInboxItem,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  INBOX_DECISIONS,
  INBOX_STATUSES,
  isReviewSocketPath,
  listInbox,
  MAX_INBOX_FEEDBACK_LENGTH,
  REVIEW_PANE_PATTERN,
  requestInboxItem,
  type DecideInboxItemResult,
  type InboxItem,
} from "@breakdown/core";
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

/** What the live session that queued the item is told: the decision, the note, and the one command that closes the loop. */
export function inboxNotifyText(result: DecideInboxItemResult, message: string): string {
  const note = message.trim() === "" ? "" : ` Note: ${message.trim()}`;
  switch (result.after) {
    case "accepted":
      return `[inbox] Accepted: "${result.title}".${note} Carry it out now, then run: inbox done ${result.id} "<what you did, with link>"`;
    case "changes":
      return `[inbox] Changes requested on "${result.title}":${note} Revise the draft and re-queue it with the same --key (inbox request).`;
    default:
      return `[inbox] Dismissed: "${result.title}".${note} Drop it; nothing to send.`;
  }
}

type Notified = { ok: true; pane: string } | { ok: false; reason: string };

const inboxDecisionProcedure = publicProcedure.input(inboxDecisionInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); inbox decisions are refused." });
  }
  let result: DecideInboxItemResult;
  try {
    result = await decideInboxItem(ctx.db, input.id, { decision: input.decision, message: input.message });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
  // A failed notification never fails the decision: it is recorded either way.
  let notified: Notified = { ok: false, reason: "the item was not queued from a live session" };
  if (result.pane !== null && REVIEW_PANE_PATTERN.test(result.pane) && result.socket !== null && isReviewSocketPath(result.socket) && ctx.runHerdr !== undefined) {
    try {
      await ctx.runHerdr(["agent", "prompt", result.pane, inboxNotifyText(result, input.message)], result.socket);
      notified = { ok: true, pane: result.pane };
    } catch (err) {
      notified = { ok: false, reason: err instanceof Error && err.message !== "" ? err.message : "herdr failed" };
    }
  }
  return { ...result, notified };
});

export const inboxRequestInputSchema = z.object({
  key: z.string().trim().min(1).max(200).regex(/^[a-z][a-z0-9_-]*:\S+$/, "must be a canonical key like session:<slug> or asana:task/<gid>"),
  title: z.string().trim().min(1).max(DEFAULT_MAX_TITLE_LENGTH),
  content: z.string().max(DEFAULT_MAX_CONTENT_LENGTH),
  metadata: z.record(z.string(), z.unknown()),
});

const inboxRequestProcedure = publicProcedure.input(inboxRequestInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  try {
    return await requestInboxItem(ctx.db, { externalId: input.key, title: input.title, content: input.content, metadata: input.metadata });
  } catch (err) {
    throw mapCoreError("inboxRequest", err);
  }
});

export const inboxCompleteInputSchema = z.object({ id: z.string().uuid(), note: z.string().trim().min(1).max(MAX_INBOX_FEEDBACK_LENGTH) });

const inboxCompleteProcedure = publicProcedure.input(inboxCompleteInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  try {
    return await completeInboxItem(ctx.db, input.id, input.note);
  } catch (err) {
    throw mapCoreError("inboxComplete", err);
  }
});

export const inboxRouter = router({
  inbox: inboxProcedure,
  inboxDecision: inboxDecisionProcedure,
  inboxRequest: inboxRequestProcedure,
  inboxComplete: inboxCompleteProcedure,
});
