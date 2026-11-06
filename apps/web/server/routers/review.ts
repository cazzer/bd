// The review decision (board-visual-reviews, design.md decision 5; the
// local-web-api delta's "review decision request"): the board's one write.
// It runs `bd` in a registered checkout from a browser request, so every
// refusal happens before any write command, in this order:
//
//   1. the server is read-only (BRAIN_READ_ONLY)              → FORBIDDEN
//   2. no review writer in the context                         → PRECONDITION_FAILED
//   3. no checkout registered by a beads ingest for the key    → NOT_FOUND
//   4. the project holds no such item                          → NOT_FOUND
//   5. the item folded (merge) to a different bead id          → PRECONDITION_FAILED
//   6. the item is not a review a tracker loaded               → PRECONDITION_FAILED
//   7. the review is already closed                            → CONFLICT
//   8. the registered path is not a directory                  → PRECONDITION_FAILED
//   9. a decision on the same item is still being written      → CONFLICT
//  10. the tracker's own record (`bd show`) is another issue or
//      not a review (PRECONDITION_FAILED), or is closed (CONFLICT)
//  11. the option does not fit that record: an option the record does not
//      offer, an option on a review that offers none, an accept without
//      one on a review that does, an option whose question or text differs
//      from `seen`, or any accept on a card the tracker holds but nobody can
//      read (PRECONDITION_FAILED)
//
// 1 and 2 touch neither the database nor the disk; 1–9 run no command. The
// checkout comes from the registry, never from the request, and only from a
// registry node whose last writer was a beads ingest
// (`getRegisteredBeadsProject`): a registry-shaped node an agent wrote
// through `brain_write` cannot point `bd` at a directory of its choosing.
// The bead id passed to `bd` is the stored item's, asserted equal to the
// requested one, so a merge that folded the request onto another bead is
// refused rather than written to a bead the person did not open. The store
// is only a first filter: the writer re-reads the record from the tracker
// (10) before writing. The input schema bounds the message so the comment,
// prefix included, fits the review contract's comment cap; bounds an
// option to REVIEW_OPTION_ID_PATTERN, refuses one sent with `changes`, and
// requires `seen` (what the person saw; caps are core's fitted lengths) with
// an option and only with one (decision-card-reviews, design.md decision
// 5); refuses C0
// controls other than newline and tab, DEL, C1 controls (U+0080–009F), and the bidirectional
// embedding/override/isolate characters (U+202A–202E, U+2066–2069), which
// could make the thread read differently from what was written; and
// requires the item id to start with a letter or digit (never a flag).
//
// A tracker failure is data, not a tRPC error: `{ ok: false, error, partial,
// uncertain? }` with `written` naming the steps that landed and `uncertain`
// a step that timed out and may have landed, so the drawer can show the
// tracker's message and what is already there. Whenever a write command ran
// at all, the watcher is woken for the project so the board shows whatever
// landed without waiting for an fs event; the wake runs from the writer's
// `onWritten`, after the bd steps and before the pane notification, so the
// board never waits on herdr. `notified` is the writer's push to the
// requesting pane (review-writer.ts header): `{ ok: true, pane }` or
// `{ ok: false, reason }` — "the decision was not fully written" when the
// tracker failed. A failed notification never fails the request.

import { stat } from "node:fs/promises";
import {
  getBoardItem,
  getRegisteredBeadsProject,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_OPTION_LABEL_LENGTH,
  MAX_REVIEW_OPTION_TEXT_LENGTH,
  MAX_REVIEW_QUESTION_LENGTH,
  PROJECT_KEY_PATTERN,
  REVIEW_OPTION_ID_PATTERN,
} from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { ReviewDecisionInFlightError, ReviewRecordRefusedError, type ReviewNotified, type ReviewStep } from "../review-writer.js";
import { publicProcedure, router } from "../trpc.js";

/** Room left in a comment for its prefix: `Changes requested: ` (19), or `Accepted: <option> — ` (at most 29 with a 16-character id). */
export const MAX_REVIEW_MESSAGE_LENGTH = MAX_REVIEW_COMMENT_LENGTH - 32;
export const REVIEW_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** C0 controls but newline and tab, DEL, C1 controls, and the bidi embedding/override/isolate characters. */
// eslint-disable-next-line no-control-regex
const REFUSED_MESSAGE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export const reviewDecisionInputSchema = z
  .object({
    project: z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`),
    item: z.string().regex(REVIEW_ITEM_ID_PATTERN, "must be a bead id: a letter or digit, then letters, digits, '.', '_', ':' or '-', at most 200 characters"),
    decision: z.enum(["accept", "changes"]),
    message: z
      .string()
      .refine((m) => !REFUSED_MESSAGE_CHARS.test(m), "must not contain control characters (other than newline and tab) or bidirectional override characters")
      .trim()
      .max(MAX_REVIEW_MESSAGE_LENGTH, `must be at most ${MAX_REVIEW_MESSAGE_LENGTH} characters`),
    option: z.string().regex(REVIEW_OPTION_ID_PATTERN, "must be an option id: a letter or digit, then letters, digits, '_' or '-', at most 16 characters").optional(),
    seen: z
      .object({
        question: z.string().max(MAX_REVIEW_QUESTION_LENGTH),
        label: z.string().max(MAX_REVIEW_OPTION_LABEL_LENGTH),
        what: z.string().max(MAX_REVIEW_OPTION_TEXT_LENGTH).optional(),
        risk: z.string().max(MAX_REVIEW_OPTION_TEXT_LENGTH).optional(),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.decision === "changes" && input.message === "") {
      ctx.addIssue({ code: "custom", path: ["message"], message: "is required when requesting changes — say what needs to change" });
    }
    if (input.decision === "changes" && input.option !== undefined) {
      ctx.addIssue({ code: "custom", path: ["option"], message: "is chosen only by accepting; request changes without one" });
    }
    if (input.option !== undefined && input.seen === undefined) {
      ctx.addIssue({ code: "custom", path: ["seen"], message: "is required with an option: the question and the option's label, what, and risk as shown" });
    }
    if (input.option === undefined && input.seen !== undefined) {
      ctx.addIssue({ code: "custom", path: ["seen"], message: "is sent only with an option" });
    }
  });

export interface ReviewDecisionResult {
  ok: boolean;
  decision: "accept" | "changes";
  item: string;
  written: ReviewStep[];
  error?: string;
  partial?: boolean;
  /** A step that timed out or was killed and may have been written. */
  uncertain?: ReviewStep;
  /** Whether the requesting pane was told, and why not. */
  notified: ReviewNotified;
}

const reviewDecisionProcedure = publicProcedure.input(reviewDecisionInputSchema).mutation(async ({ ctx, input }): Promise<ReviewDecisionResult> => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); review decisions are refused." });
  }
  const writer = ctx.reviewWriter;
  if (writer === undefined) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This server has no review writer configured; review decisions are unavailable." });
  }

  let project;
  let item;
  try {
    project = await getRegisteredBeadsProject(ctx.db, input.project);
    item = project === null ? null : await getBoardItem(ctx.db, { project: input.project, externalId: input.item });
  } catch (err) {
    throw mapCoreError("reviewDecision", err);
  }
  if (project === null) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Project "${input.project}" has no checkout registered by a beads ingest; register it with \`pnpm ingest:beads <path> --project ${input.project}\`.`,
    });
  }
  if (item === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Item "${input.item}" is not in project "${input.project}".` });
  }
  if (item.externalId !== input.item) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Item "${input.item}" was merged into "${item.externalId}"; open that item and decide there.` });
  }
  if (!item.isReview || item.sourceSystem !== "beads") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Item "${input.item}" is not a review (a beads issue labelled "review"); only reviews take a decision.` });
  }
  if (item.status === "closed") {
    throw new TRPCError({ code: "CONFLICT", message: `Review "${input.item}" is already closed.` });
  }
  let isDirectory = false;
  try {
    isDirectory = (await stat(project.path)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The registered checkout for "${input.project}" is not a directory: ${project.path}.` });
  }

  let result;
  try {
    result = await writer.write({
      project: input.project,
      cwd: project.path,
      externalId: item.externalId,
      decision: input.decision,
      message: input.message,
      option: input.option,
      seen: input.seen,
      onWritten: ({ attempted }) => {
        if (attempted) ctx.watcher?.wake(input.project);
      },
    });
  } catch (err) {
    if (err instanceof ReviewDecisionInFlightError) throw new TRPCError({ code: "CONFLICT", message: err.message });
    if (err instanceof ReviewRecordRefusedError) throw new TRPCError({ code: err.reason === "closed" ? "CONFLICT" : "PRECONDITION_FAILED", message: err.message });
    throw err;
  }
  if (!result.ok) {
    const uncertain = result.uncertain ? ` (uncertain: ${result.uncertain})` : "";
    console.error(`[breakdown-web] review decision on ${input.project}/${input.item} failed after [${result.written.join(", ")}]${uncertain}: ${result.error}`);
  }

  return {
    ok: result.ok,
    decision: input.decision,
    item: input.item,
    written: result.written,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.partial !== undefined ? { partial: result.partial } : {}),
    ...(result.uncertain !== undefined ? { uncertain: result.uncertain } : {}),
    notified: result.notified,
  };
});

export const reviewRouter = router({
  reviewDecision: reviewDecisionProcedure,
});
