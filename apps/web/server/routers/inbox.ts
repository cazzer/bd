// The inbox (inbox.ts in core): the queue read and the person's decision.
// Deciding is a pure Postgres write — it records the decision and moves the
// item to the next turn (accepted → the executor session's, changes → the
// agent's). Nothing here calls a model. The commands it runs are herdr's:
// telling a live session about a decision, and opening an interactive
// session on an item when the person asks to go deep (inbox-session.ts).

import {
  completeInboxItem,
  decideInboxItem,
  handOffInboxItem,
  INBOX_HANDOFF_STATUSES,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  INBOX_DECISIONS,
  INBOX_STATUSES,
  isReviewSocketPath,
  listInbox,
  MAX_INBOX_FEEDBACK_LENGTH,
  REVIEW_PANE_PATTERN,
  releaseInboxItem,
  REVIEW_OPTION_ID_PATTERN,
  requestInboxItem,
  type DecideInboxItemResult,
  type InboxItem,
} from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { openInboxSession } from "../inbox-session.js";
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
  /** For an accept on a card with options: the option chosen (the server checks the stored card offers it). */
  option: z.string().regex(REVIEW_OPTION_ID_PATTERN).optional(),
});

/** What the live session that queued the item is told: the decision, the note, and the one command that closes the loop. */
export function inboxNotifyText(result: DecideInboxItemResult, message: string, option?: string): string {
  const note = message.trim() === "" ? "" : ` Note: ${message.trim()}`;
  switch (result.after) {
    case "accepted":
      return `[inbox] Accepted${option === undefined ? "" : ` option ${option}`}: "${result.title}".${note} Carry it out now, then run: inbox done ${result.id} "<what you did, with link>"`;
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
    result = await decideInboxItem(ctx.db, input.id, { decision: input.decision, message: input.message, ...(input.option === undefined ? {} : { option: input.option }) });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
  // A failed notification never fails the decision: it is recorded either way.
  let notified: Notified = { ok: false, reason: "the item was not queued from a live session" };
  if (result.pane !== null && REVIEW_PANE_PATTERN.test(result.pane) && result.socket !== null && isReviewSocketPath(result.socket) && ctx.runHerdr !== undefined) {
    try {
      await ctx.runHerdr(["agent", "prompt", result.pane, inboxNotifyText(result, input.message, input.option)], result.socket);
      notified = { ok: true, pane: result.pane };
    } catch (err) {
      notified = { ok: false, reason: err instanceof Error && err.message !== "" ? err.message : "herdr failed" };
    }
  }
  return { ...result, notified };
});

/** Moves an undigested item to Needs me as it is (the person will decide without the agent's reading); recorded as `release`. */
const inboxReleaseProcedure = publicProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); releasing an item is refused." });
  }
  try {
    const result = await releaseInboxItem(ctx.db, input.id);
    return { id: result.id, before: result.before, after: result.after };
  } catch (err) {
    throw mapCoreError("inboxRelease", err);
  }
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

const inboxIdSchema = z.object({ id: z.string().uuid() });

async function loadItem(ctx: { db: Parameters<typeof listInbox>[0] }, id: string): Promise<InboxItem> {
  let item: InboxItem | undefined;
  try {
    item = (await listInbox(ctx.db, { ids: [id], statuses: INBOX_STATUSES })).items[0];
  } catch (err) {
    throw mapCoreError("inbox", err);
  }
  if (item === undefined) throw new TRPCError({ code: "NOT_FOUND", message: `No inbox item ${id}.` });
  return item;
}

const NO_HERDR = "herdr isn't reachable from the breakdown server. Start `pnpm dev` from inside a herdr pane (or keep herdr's default socket) and try again.";

const inboxOpenSessionProcedure = publicProcedure.input(inboxIdSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  if (ctx.herdrJson === undefined || ctx.herdrSocket === undefined || ctx.herdrSocket === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_HERDR });
  const item = await loadItem(ctx, input.id);
  if (!INBOX_HANDOFF_STATUSES.includes(item.status)) {
    throw new TRPCError({ code: "CONFLICT", message: `This item is ${item.status}; only an item waiting on you (or sent back) can be opened in a session.` });
  }
  let opened;
  try {
    opened = await openInboxSession(ctx.herdrJson, ctx.herdrSocket, item, { cwd: ctx.sessionCwd ?? process.cwd() });
  } catch (err) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't open the session: ${err instanceof Error ? err.message : String(err)}` });
  }
  try {
    await handOffInboxItem(ctx.db, item.id, { pane: opened.pane, socket: ctx.herdrSocket, tab: opened.tab });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
  return opened;
});

const inboxFocusSessionProcedure = publicProcedure.input(inboxIdSchema).mutation(async ({ ctx, input }) => {
  if (ctx.herdrJson === undefined || ctx.herdrSocket === undefined || ctx.herdrSocket === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_HERDR });
  const item = await loadItem(ctx, input.id);
  if (item.sessionTab === null) throw new TRPCError({ code: "CONFLICT", message: "This item was never opened in a session." });
  try {
    await ctx.herdrJson(["tab", "focus", item.sessionTab], ctx.herdrSocket);
  } catch (err) {
    throw new TRPCError({ code: "NOT_FOUND", message: `The session tab is gone (${err instanceof Error ? err.message : String(err)}). Open a new session instead.` });
  }
  return { tab: item.sessionTab };
});

export const inboxRouter = router({
  inboxOpenSession: inboxOpenSessionProcedure,
  inboxFocusSession: inboxFocusSessionProcedure,
  inbox: inboxProcedure,
  inboxDecision: inboxDecisionProcedure,
  inboxRelease: inboxReleaseProcedure,
  inboxRequest: inboxRequestProcedure,
  inboxComplete: inboxCompleteProcedure,
});
