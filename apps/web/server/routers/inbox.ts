// The inbox (inbox.ts in core): the queue read and the person's decision.
// Deciding is a pure Postgres write — it records the decision and moves the
// item to the next turn (accepted → the executor session's, changes → the
// agent's). Nothing here calls a model. The commands it runs are herdr's:
// telling a live session about a decision, and opening an interactive
// session on an item when the person asks to go deep (inbox-session.ts).
//
// An item a remote hangar session filed (its token is session-bound) is
// told through that session's messages instead, appended by core in the
// decision's own transaction, so no herdr command runs for it
// (hangar-queue decision 6). The session comes from the admitted token,
// never the body. Once that session has ended, an accept or send-back is
// refused with CONFLICT (nothing written): it must not quietly become a
// local execution. A dismiss or release clears the session from the item,
// sends nothing, and runs no herdr command either; the decision reports
// that. A hand-off (inboxOpenSession) takes the item local explicitly.

import {
  completeInboxItem,
  decideInboxItem,
  handOffInboxItem,
  HostBinaryUnavailableError,
  INBOX_HANDOFF_STATUSES,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  INBOX_DECISIONS,
  INBOX_STATUSES,
  inboxNotifyText,
  isReviewSocketPath,
  listInbox,
  MAX_INBOX_FEEDBACK_LENGTH,
  REVIEW_PANE_PATTERN,
  releaseInboxItem,
  unlinkInboxWorkContext,
  REVIEW_OPTION_ID_PATTERN,
  requestInboxItem,
  type DecideInboxItemResult,
  type InboxItem,
} from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError, refuseMissingBinary } from "../errors.js";
import { openInboxSession } from "../inbox-session.js";
import { agentProcedure, humanProcedure, router } from "../trpc.js";

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

const inboxProcedure = agentProcedure.input(inboxInputSchema).query(async ({ ctx, input }) => {
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

type Notified = { ok: true; pane: string } | { ok: true; session: string } | { ok: false; reason: string };

const inboxDecisionProcedure = humanProcedure.input(inboxDecisionInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); inbox decisions are refused." });
  }
  let result: DecideInboxItemResult;
  try {
    result = await decideInboxItem(ctx.db, input.id, { decision: input.decision, message: input.message, ...(input.option === undefined ? {} : { option: input.option }) }, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
  // A failed notification never fails the decision: it is recorded either way.
  let notified: Notified = { ok: false, reason: "the item was not queued from a live session" };
  if (result.endedSession !== null) {
    notified = { ok: false, reason: "the hangar session that filed it has ended" };
  } else if (result.session !== null) {
    // Already queued as the session's message, in the decision's transaction.
    notified = { ok: true, session: result.session };
  } else if (result.pane !== null && REVIEW_PANE_PATTERN.test(result.pane) && result.socket !== null && isReviewSocketPath(result.socket) && ctx.runHerdr !== undefined) {
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
const inboxReleaseProcedure = humanProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); releasing an item is refused." });
  }
  try {
    const result = await releaseInboxItem(ctx.db, input.id, {}, { actor: ctx.client ?? undefined });
    return { id: result.id, before: result.before, after: result.after };
  } catch (err) {
    throw mapCoreError("inboxRelease", err);
  }
});

/** The person's "not this" on an item's work context: removes its `about` link; status and feedback stay. */
const inboxUnlinkWorkProcedure = humanProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); unlinking an item's work is refused." });
  }
  try {
    return await unlinkInboxWorkContext(ctx.db, input.id);
  } catch (err) {
    throw mapCoreError("inboxUnlinkWork", err);
  }
});

export const inboxRequestInputSchema = z.object({
  key: z.string().trim().min(1).max(200).regex(/^[a-z][a-z0-9_-]*:\S+$/, "must be a canonical key like session:<slug> or asana:task/<gid>"),
  title: z.string().trim().min(1).max(DEFAULT_MAX_TITLE_LENGTH),
  content: z.string().max(DEFAULT_MAX_CONTENT_LENGTH),
  metadata: z.record(z.string(), z.unknown()),
});

const inboxRequestProcedure = agentProcedure.input(inboxRequestInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  try {
    return await requestInboxItem(ctx.db, {
      externalId: input.key,
      title: input.title,
      content: input.content,
      metadata: input.metadata,
      actor: ctx.client ?? undefined,
      session: ctx.sessionId ?? undefined,
    });
  } catch (err) {
    throw mapCoreError("inboxRequest", err);
  }
});

export const inboxCompleteInputSchema = z.object({ id: z.string().uuid(), note: z.string().trim().min(1).max(MAX_INBOX_FEEDBACK_LENGTH) });

const inboxCompleteProcedure = agentProcedure.input(inboxCompleteInputSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  try {
    // A session-bound token completes only its own session's items (hangar-queue decision 9).
    return await completeInboxItem(ctx.db, input.id, input.note, { actor: ctx.client ?? undefined, ...(ctx.sessionId == null ? {} : { session: ctx.sessionId }) });
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

const inboxOpenSessionProcedure = humanProcedure.input(inboxIdSchema).mutation(async ({ ctx, input }) => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
  refuseMissingBinary(ctx.missingBinaries, "herdr");
  if (ctx.herdrJson === undefined || ctx.herdrSocket === undefined || ctx.herdrSocket === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_HERDR });
  const item = await loadItem(ctx, input.id);
  if (!INBOX_HANDOFF_STATUSES.includes(item.status)) {
    throw new TRPCError({ code: "CONFLICT", message: `This item is ${item.status}; only an item waiting on you (or sent back) can be opened in a session.` });
  }
  let opened;
  try {
    opened = await openInboxSession(ctx.herdrJson, ctx.herdrSocket, item, { cwd: ctx.sessionCwd ?? process.cwd() });
  } catch (err) {
    if (err instanceof HostBinaryUnavailableError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't open the session: ${err instanceof Error ? err.message : String(err)}` });
  }
  try {
    await handOffInboxItem(ctx.db, item.id, { pane: opened.pane, socket: ctx.herdrSocket, tab: opened.tab }, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("inboxDecision", err);
  }
  return opened;
});

const inboxFocusSessionProcedure = humanProcedure.input(inboxIdSchema).mutation(async ({ ctx, input }) => {
  refuseMissingBinary(ctx.missingBinaries, "herdr");
  if (ctx.herdrJson === undefined || ctx.herdrSocket === undefined || ctx.herdrSocket === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_HERDR });
  const item = await loadItem(ctx, input.id);
  if (item.sessionTab === null) throw new TRPCError({ code: "CONFLICT", message: "This item was never opened in a session." });
  try {
    await ctx.herdrJson(["tab", "focus", item.sessionTab], ctx.herdrSocket);
  } catch (err) {
    if (err instanceof HostBinaryUnavailableError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
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
  inboxUnlinkWork: inboxUnlinkWorkProcedure,
  inboxRequest: inboxRequestProcedure,
  inboxComplete: inboxCompleteProcedure,
});
