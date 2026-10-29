// The review decision (board-visual-reviews, design.md decision 5; the
// local-web-api delta's "review decision request"): the board's one write.
// It runs `bd` in a registered checkout from a browser request, so every
// refusal happens before any command, in this order:
//
//   1. the server is read-only (BRAIN_READ_ONLY)          → FORBIDDEN
//   2. no review writer in the context                     → PRECONDITION_FAILED
//   3. the project has no registered checkout              → NOT_FOUND
//   4. the project holds no such item                      → NOT_FOUND
//   5. the item is not a review a tracker loaded           → PRECONDITION_FAILED
//   6. the review is already closed                        → CONFLICT
//   7. the registered path is not a directory              → PRECONDITION_FAILED
//   8. the item folded (merge) to a different bead id      → PRECONDITION_FAILED
//   9. a decision on the same item is still being written  → CONFLICT
//
// 1 and 2 touch neither the database nor the disk. The checkout comes from
// the registry, never from the request, and the bead id passed to `bd` is
// the stored item's — asserted equal to the requested one, so a merge that
// folded the request onto another bead is refused rather than written to a
// bead the person did not open. The input schema bounds the message so the
// comment, prefix included, fits the review contract's comment cap, refuses
// NUL (execFile would throw on it), and requires the item id to start with
// a letter or digit (never a flag to `bd`).
//
// A tracker failure is data, not a tRPC error: `{ ok: false, error, partial }`
// with `written` naming the steps that landed, so the drawer can show the
// tracker's message and whether a comment is already there. Whenever
// anything was written — success or partial — the watcher is woken for the
// project so the board moves without waiting for an fs event. `notified` is
// null until bd-ker.5 adds the push to the requesting pane.

import { stat } from "node:fs/promises";
import { getBoardItem, listBeadsProjects, MAX_REVIEW_COMMENT_LENGTH, PROJECT_KEY_PATTERN } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { ReviewDecisionInFlightError, type ReviewStep } from "../review-writer.js";
import { publicProcedure, router } from "../trpc.js";

/** Room left in a comment for the `Changes requested: ` prefix. */
export const MAX_REVIEW_MESSAGE_LENGTH = MAX_REVIEW_COMMENT_LENGTH - 32;
export const REVIEW_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const reviewDecisionInputSchema = z
  .object({
    project: z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`),
    item: z.string().regex(REVIEW_ITEM_ID_PATTERN, "must be a bead id: a letter or digit, then letters, digits, '.', '_', ':' or '-', at most 200 characters"),
    decision: z.enum(["accept", "changes"]),
    message: z
      .string()
      .refine((m) => !m.includes("\u0000"), "must not contain NUL")
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
  /** Whether the requesting pane was told; null until bd-ker.5. */
  notified: null;
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
    project = (await listBeadsProjects(ctx.db)).find((p) => p.key === input.project);
    item = project === undefined ? null : await getBoardItem(ctx.db, { project: input.project, externalId: input.item });
  } catch (err) {
    throw mapCoreError("reviewDecision", err);
  }
  if (project === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Project "${input.project}" has no registered checkout; register it with \`pnpm ingest:beads <path> --project ${input.project}\`.` });
  }
  if (item === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Item "${input.item}" is not in project "${input.project}".` });
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
  if (item.externalId !== input.item) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Item "${input.item}" was merged into "${item.externalId}"; open that item and decide there.` });
  }

  let result;
  try {
    result = await writer.write({ project: input.project, cwd: project.path, externalId: item.externalId, decision: input.decision, message: input.message });
  } catch (err) {
    if (err instanceof ReviewDecisionInFlightError) throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
  if (!result.ok) {
    console.error(`[breakdown-web] review decision on ${input.project}/${input.item} failed after [${result.written.join(", ")}]: ${result.error}`);
  }
  if (result.written.length > 0) ctx.watcher?.wake(input.project);

  return {
    ok: result.ok,
    decision: input.decision,
    item: input.item,
    written: result.written,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.partial !== undefined ? { partial: result.partial } : {}),
    notified: null,
  };
});

export const reviewRouter = router({
  reviewDecision: reviewDecisionProcedure,
});
