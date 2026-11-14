// The board's read procedures (live-beads-board; local-web-api spec, "Board
// read and live change stream"): `board` — every work item of the chosen
// projects with its column, nearest epic, and open blockers, never content
// (packages/core/src/board.ts, one statement) — and `beadsProjects`, the
// registered checkouts. Thin handlers like every other router: Zod at the
// boundary, one core call, `mapCoreError` on failure, `Date`s as strings
// (../dto.ts).
//
// The change subscription and the manual refresh live in a separate router
// (board-live.ts) so this file stays the read side only.
//
// Bounded like the listing: core caps the read at MAX_BOARD_ITEMS cards and
// reports `truncated` itself; `boundResponse` additionally drops cards from
// the tail (the least urgent, oldest-updated of the last column order) when
// the serialized answer would exceed the response budget, naming them in
// `droppedCardIds`. `truncated` is the OR of the two, so the board has one
// honest flag. Epics are unbounded here: at most one row per item, a title
// and three short fields each, and dropping a lane header would orphan its
// cards.
//
// `boardItem` (board-visual-reviews, design.md decision 2) is the drawer's
// read: one item of one project by its external id, with content, labels,
// review, and comments (core's `getBoardItem`), as `{ item }` — null when the
// project holds no such item. It is not passed through `boundResponse`: it
// is one row, and core already bounds every part of it (content and metadata
// by the write path's caps, the comment thread by the review contract's
// character budget).
//
// `reviewQueue` (review-queue, design.md decision 1) is the pending review
// queue every view's indicator reads: no input, core's `listPendingReviews`
// at its default cap (MAX_PENDING_REVIEWS), as `{ reviews, total,
// truncated }`. One store read, no tracker command, so a read-only server
// serves it. Not passed through `boundResponse`: at most 100 rows of a title
// and a 200-character summary line, far under the budget.

import { getBoardItem, getWorkBoard, listBeadsProjects, listPendingReviews, MAX_BOARD_ITEM_ID_LENGTH, MAX_BOARD_PROJECTS, PROJECT_KEY_PATTERN } from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import { toBeadsProjectDto, toBoardCardDto, toBoardItemDto, toPendingReviewDto } from "../dto.js";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

export const boardInputSchema = z.object({
  /** Project keys to read; absent reads every registered project, an empty list reads none. */
  projects: z
    .array(z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`))
    .max(MAX_BOARD_PROJECTS, `must contain at most ${MAX_BOARD_PROJECTS} projects`)
    .optional(),
});

const boardProcedure = publicProcedure.input(boardInputSchema).query(async ({ ctx, input }) => {
  let board;
  try {
    board = await getWorkBoard(ctx.db, { projects: input.projects });
  } catch (err) {
    throw mapCoreError("board", err);
  }
  const cards = board.cards.map(toBoardCardDto);
  return boundResponse(
    cards,
    (card) => card.id,
    (kept, meta) => ({
      cards: kept,
      epics: board.epics,
      omittedClosed: board.omittedClosed,
      truncated: board.truncated || meta.truncated,
      droppedCardIds: meta.droppedIds,
    }),
    ctx.responseCharBudget,
  );
});

export type LastIngest =
  | { ok: true; at: string; changed: boolean; nodes: { created: number; updated: number; unchanged: number } }
  | { ok: false; at: string; error: string };

const beadsProjectsProcedure = publicProcedure.query(async ({ ctx }) => {
  try {
    const projects = await listBeadsProjects(ctx.db);
    // Core cannot know a rolled-back failure, so the last-ingest outcome is joined here from the watcher's in-memory record: null with no watcher or no attempt yet.
    const outcomes = new Map((ctx.watcher?.outcomes() ?? []).map((o) => [o.project, o]));
    return {
      projects: projects.map((p) => {
        const o = outcomes.get(p.key);
        const lastIngest: LastIngest | null = !o
          ? null
          : o.ok
            ? { ok: true, at: o.at, changed: o.changed, nodes: o.nodes }
            : { ok: false, at: o.at, error: o.error };
        return { ...toBeadsProjectDto(p), lastIngest };
      }),
    };
  } catch (err) {
    throw mapCoreError("beadsProjects", err);
  }
});

export const boardItemInputSchema = z.object({
  project: z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`),
  /** The item's external id (a bead id). */
  item: z.string().min(1).max(MAX_BOARD_ITEM_ID_LENGTH),
});

const boardItemProcedure = publicProcedure.input(boardItemInputSchema).query(async ({ ctx, input }) => {
  try {
    const item = await getBoardItem(ctx.db, { project: input.project, externalId: input.item });
    return { item: item === null ? null : toBoardItemDto(item, ctx.reviewImageRoot) };
  } catch (err) {
    throw mapCoreError("boardItem", err);
  }
});

const reviewQueueProcedure = publicProcedure.query(async ({ ctx }) => {
  try {
    const queue = await listPendingReviews(ctx.db);
    return { reviews: queue.reviews.map(toPendingReviewDto), total: queue.total, truncated: queue.truncated };
  } catch (err) {
    throw mapCoreError("reviewQueue", err);
  }
});

export const boardRouter = router({
  board: boardProcedure,
  boardItem: boardItemProcedure,
  beadsProjects: beadsProjectsProcedure,
  reviewQueue: reviewQueueProcedure,
});
