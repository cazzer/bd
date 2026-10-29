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
// prefix included, fits the review contract's comment cap; refuses C0
// controls other than newline and tab, DEL, and the bidirectional
// embedding/override/isolate characters (U+202A–202E, U+2066–2069), which
// could make the thread read differently from what was written; and
// requires the item id to start with a letter or digit (never a flag).
//
// A tracker failure is data, not a tRPC error: `{ ok: false, error, partial,
// uncertain? }` with `written` naming the steps that landed and `uncertain`
// a step that timed out and may have landed, so the drawer can show the
// tracker's message and what is already there. Whenever a write command ran
// at all, the watcher is woken for the project so the board shows whatever
// landed without waiting for an fs event. `notified` is the writer's push to
// the requesting pane (review-writer.ts header): `{ ok: true, pane }`,
// `{ ok: false, reason }`, or null when the decision was not fully written
// and nobody was told. A failed notification never fails the request.

import { stat } from "node:fs/promises";
import { getBoardItem, getRegisteredBeadsProject, MAX_REVIEW_COMMENT_LENGTH, PROJECT_KEY_PATTERN } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { ReviewDecisionInFlightError, ReviewRecordRefusedError, type ReviewNotified, type ReviewStep } from "../review-writer.js";
import { publicProcedure, router } from "../trpc.js";

/** Room left in a comment for the `Changes requested: ` prefix. */
export const MAX_REVIEW_MESSAGE_LENGTH = MAX_REVIEW_COMMENT_LENGTH - 32;
export const REVIEW_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** C0 controls but newline and tab, DEL, and the bidi embedding/override/isolate characters. */
// eslint-disable-next-line no-control-regex
const REFUSED_MESSAGE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

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
  })
  .superRefine((input, ctx) => {
    if (input.decision === "changes" && input.message === "") {
      ctx.addIssue({ code: "custom", path: ["message"], message: "is required when requesting changes — say what needs to change" });
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
  /** Whether the requesting pane was told; null when the decision was not fully written. */
  notified: ReviewNotified | null;
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
    result = await writer.write({ project: input.project, cwd: project.path, externalId: item.externalId, decision: input.decision, message: input.message });
  } catch (err) {
    if (err instanceof ReviewDecisionInFlightError) throw new TRPCError({ code: "CONFLICT", message: err.message });
    if (err instanceof ReviewRecordRefusedError) throw new TRPCError({ code: err.reason === "closed" ? "CONFLICT" : "PRECONDITION_FAILED", message: err.message });
    throw err;
  }
  if (!result.ok) {
    const uncertain = result.uncertain ? ` (uncertain: ${result.uncertain})` : "";
    console.error(`[breakdown-web] review decision on ${input.project}/${input.item} failed after [${result.written.join(", ")}]${uncertain}: ${result.error}`);
  }
  if (result.attempted) ctx.watcher?.wake(input.project);

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
