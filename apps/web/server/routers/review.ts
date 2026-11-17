// The review decision (board-visual-reviews, design.md decision 5; the
// local-web-api delta's "review decision request"): the board's one write.
// It runs `bd` in a registered checkout from a browser request, or, on a
// server without `bd` (the Jetson), queues the decision for the laptop relay
// (laptop-relay design.md decisions 6 and 9). Every refusal happens before
// any write command or any queued action, in this order:
//
//   1. the server is read-only (BRAIN_READ_ONLY)              → FORBIDDEN
//   2. `bd` is on PATH but no review writer is in the context  → PRECONDITION_FAILED
//   3. no checkout registered by a beads ingest for the key    → NOT_FOUND
//   4. the project holds no such item                          → NOT_FOUND
//   5. the item folded (merge) to a different bead id          → PRECONDITION_FAILED
//   6. the item is not a review a tracker loaded               → PRECONDITION_FAILED
//   7. the review is already closed                            → CONFLICT
//
// Then, with `bd` on PATH (direct; unchanged by the relay):
//
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
// Or, with `bd` missing (queued; `{ queued: true, actionId }`):
//
//   8. the bead id is not one the relay's allowlist accepts    → PRECONDITION_FAILED
//   9. a decision on the same review is already queued or
//      claimed for the relay (the open-target index)           → CONFLICT
//
// The queued path skips the writer check and the `stat` of the checkout:
// the registered path is the Mac's, not this host's. The relay runs 10 and
// 11 itself, through the same writer, when it claims the action; the store
// checks (3–7) still run here. The action's payload is built from the
// registry's path and the stored item's id, never from the request, and is
// validated again by core's payload schema and allowlist at enqueue.
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
// prefix included, fits the review contract's comment cap (core's
// MAX_REVIEW_DECISION_MESSAGE_LENGTH, which the relay payload shares);
// bounds an option to REVIEW_OPTION_ID_PATTERN, refuses one sent with
// `changes`, and requires `seen` (what the person saw; caps are core's
// fitted lengths) with an option and only with one (decision-card-reviews,
// design.md decision 5); refuses core's REVIEW_DECISION_MESSAGE_REFUSED_CHARS
// — C0 controls other than newline and tab, DEL, C1 controls
// (U+0080–009F), and the bidirectional embedding/override/isolate
// characters (U+202A–202E, U+2066–2069), which could make the thread read
// differently from what was written; and requires the item id to start
// with a letter or digit (never a flag).
//
// Decision images (review-decision-images, design.md decisions 2 and 3):
// `images` is at most core's MAX_DECISION_IMAGES paths relative to the media
// root, each `<project>/<item>/<run>/<name>` for this decision's own project
// and item (core's isDecisionImagePath), and the message must fit beside
// them (core's decisionMessageBudget; the refusal says how much to cut).
// Both are schema refusals. After the store checks (3–7) and before any
// command or queued action, `checkDecisionImages` lstats every level under
// the media root: a missing file, a symlink, or anything but a regular file
// at the end is PRECONDITION_FAILED naming the path. The writer gets the
// relative paths for the comment and the absolute files for the prompt; a
// queued decision carries the relative paths, which the relay downloads
// through `GET /relay/v1/actions/:id/media/:n` (relay-api.ts).
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
  decisionMessageBudget,
  enqueueRelayAction,
  isDecisionImagePath,
  MAX_DECISION_IMAGE_PATH_LENGTH,
  MAX_DECISION_IMAGES,
  getBoardItem,
  getRegisteredBeadsProject,
  InvalidRelayActionError,
  isRelayIssueId,
  MAX_REVIEW_DECISION_MESSAGE_LENGTH,
  MAX_REVIEW_OPTION_LABEL_LENGTH,
  MAX_REVIEW_OPTION_TEXT_LENGTH,
  MAX_REVIEW_QUESTION_LENGTH,
  PROJECT_KEY_PATTERN,
  RelayActionPendingError,
  REVIEW_DECISION_MESSAGE_REFUSED_CHARS,
  REVIEW_IMAGE_ROOT,
  REVIEW_OPTION_ID_PATTERN,
  type BeadsProject,
  type BoardItem,
} from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Context } from "../context.js";
import { resolveDecisionImages } from "../decision-images.js";
import { mapCoreError } from "../errors.js";
import { ReviewDecisionInFlightError, ReviewRecordRefusedError, type ReviewNotified, type ReviewStep } from "../review-writer.js";
import { humanProcedure, router } from "../trpc.js";

/** Room left in a comment for its prefix: `Changes requested: ` (19), or `Accepted: <option> — ` (at most 29 with a 16-character id). Core's, shared with the relay payload. */
export const MAX_REVIEW_MESSAGE_LENGTH = MAX_REVIEW_DECISION_MESSAGE_LENGTH;
export const REVIEW_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const reviewDecisionInputSchema = z
  .object({
    project: z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`),
    item: z.string().regex(REVIEW_ITEM_ID_PATTERN, "must be a bead id: a letter or digit, then letters, digits, '.', '_', ':' or '-', at most 200 characters"),
    decision: z.enum(["accept", "changes"]),
    message: z
      .string()
      .refine((m) => !REVIEW_DECISION_MESSAGE_REFUSED_CHARS.test(m), "must not contain control characters (other than newline and tab) or bidirectional override characters")
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
    images: z
      .array(z.string().max(MAX_DECISION_IMAGE_PATH_LENGTH, `must be at most ${MAX_DECISION_IMAGE_PATH_LENGTH} characters`))
      .max(MAX_DECISION_IMAGES, `must name at most ${MAX_DECISION_IMAGES} images`)
      .optional(),
  })
  .superRefine((input, ctx) => {
    input.images?.forEach((image, i) => {
      if (!isDecisionImagePath(image, input.project, input.item)) {
        ctx.addIssue({ code: "custom", path: ["images", i], message: `${image} is not an image of this review: it must be ${input.project}/${input.item}/<run>/<name> ending in png, jpg, jpeg, gif, or webp` });
      }
    });
    const images = input.images ?? [];
    if (images.length > 0 && input.message.length > decisionMessageBudget(images)) {
      const cut = input.message.length - decisionMessageBudget(images);
      ctx.addIssue({ code: "custom", path: ["message"], message: `is too long to fit beside its images: cut ${cut} character${cut === 1 ? "" : "s"}` });
    }
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

type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>;

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

/** A decision queued for the laptop relay (no `bd` on this server): `relayAction(actionId)` reports how it went. */
export interface ReviewDecisionQueued {
  queued: true;
  actionId: number;
  decision: "accept" | "changes";
  item: string;
}

/** Steps 3–7 of the header: the registered checkout and the stored review the decision is for. */
async function loadOpenReview(ctx: Context, input: ReviewDecisionInput): Promise<{ project: BeadsProject; item: BoardItem }> {
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
  return { project, item };
}

/** The decision's images as absolute files under the media root, or PRECONDITION_FAILED naming the first that is not a regular file there (decision-images.ts). */
async function checkDecisionImages(root: string, images: readonly string[]): Promise<string[]> {
  const checked = await resolveDecisionImages(root, images);
  if (checked.ok) return checked.files;
  const message = checked.reason === "missing" ? `Image ${checked.image} is not on this server; upload it again.` : `Image ${checked.image} is not a file in the review media directory.`;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/** Queue mode (header, steps 8–9 of the queued path): the decision becomes a `review_decision` relay action. */
async function queueReviewDecision(ctx: Context, input: ReviewDecisionInput): Promise<ReviewDecisionQueued> {
  const { project, item } = await loadOpenReview(ctx, input);
  await checkDecisionImages(ctx.reviewImageRoot ?? REVIEW_IMAGE_ROOT, input.images ?? []);
  if (!isRelayIssueId(item.externalId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Item "${item.externalId}" is not a beads issue id the laptop relay can run (lowercase letters, digits, '-' and '.', like bd-a1b2); decide it on a server that has bd.`,
    });
  }
  const payload = {
    project_key: project.key,
    cwd: project.path,
    issue_id: item.externalId,
    decision: input.decision,
    message: input.message,
    ...(input.option === undefined ? {} : { option: input.option }),
    ...(input.seen === undefined ? {} : { seen: input.seen }),
    ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
  };
  let enqueued;
  try {
    enqueued = await enqueueRelayAction(ctx.db, { kind: "review_decision", payload, requestedBy: ctx.client ?? "human", originNodeId: item.id });
  } catch (err) {
    if (err instanceof RelayActionPendingError) {
      throw new TRPCError({ code: "CONFLICT", message: `A decision on this review is already waiting for the laptop relay (action ${err.openActionId}).` });
    }
    if (err instanceof InvalidRelayActionError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This decision cannot be queued for the laptop relay: ${err.message}` });
    throw mapCoreError("reviewDecision", err);
  }
  return { queued: true, actionId: enqueued.action.id, decision: input.decision, item: item.externalId };
}

const reviewDecisionProcedure = humanProcedure.input(reviewDecisionInputSchema).mutation(async ({ ctx, input }): Promise<ReviewDecisionResult | ReviewDecisionQueued> => {
  if (ctx.readOnly) {
    throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); review decisions are refused." });
  }
  if (ctx.missingBinaries?.includes("bd")) return queueReviewDecision(ctx, input);
  const writer = ctx.reviewWriter;
  if (writer === undefined) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This server has no review writer configured; review decisions are unavailable." });
  }

  const { project, item } = await loadOpenReview(ctx, input);
  let isDirectory = false;
  try {
    isDirectory = (await stat(project.path)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The registered checkout for "${input.project}" is not a directory: ${project.path}.` });
  }
  const imagePaths = input.images ?? [];
  const imageFiles = await checkDecisionImages(ctx.reviewImageRoot ?? REVIEW_IMAGE_ROOT, imagePaths);

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
      ...(imagePaths.length === 0 ? {} : { imagePaths, imageFiles }),
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
