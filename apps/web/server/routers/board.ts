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

import { getWorkBoard, listBeadsProjects, MAX_BOARD_PROJECTS, PROJECT_KEY_PATTERN } from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import { toBeadsProjectDto, toBoardCardDto } from "../dto.js";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

export const boardInputSchema = z.object({
  /** Project keys to read; absent reads every project. */
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

const beadsProjectsProcedure = publicProcedure.query(async ({ ctx }) => {
  try {
    const projects = await listBeadsProjects(ctx.db);
    return { projects: projects.map(toBeadsProjectDto) };
  } catch (err) {
    throw mapCoreError("beadsProjects", err);
  }
});

export const boardRouter = router({
  board: boardProcedure,
  beadsProjects: beadsProjectsProcedure,
});
