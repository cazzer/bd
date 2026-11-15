// The roadmap read procedure (roadmap-milestones, design.md decision 8;
// local-web-api spec, "Roadmap read"): `roadmap` — every milestone and epic
// of the chosen projects with planning dates and progress rolled up from
// their items, never content (packages/core/src/roadmap.ts, one statement).
// Same input schema and procedure builder as `board` (routers/board.ts), so
// the two accept the same projects and the same token scopes.
//
// Not passed through `boundResponse`: core caps the answer at
// MAX_ROADMAP_ROWS milestones plus epics and reports `truncated` itself, and
// each row is a title plus short fields and two small count objects, far
// under the response budget. The answer carries no `Date`s (dates are the
// stored ISO strings), so no DTO is needed.

import { getRoadmap } from "@breakdown/core";
import { mapCoreError } from "../errors.js";
import { humanProcedure, router } from "../trpc.js";
import { boardInputSchema } from "./board.js";

const roadmapProcedure = humanProcedure.input(boardInputSchema).query(async ({ ctx, input }) => {
  try {
    return await getRoadmap(ctx.db, { projects: input.projects });
  } catch (err) {
    throw mapCoreError("roadmap", err);
  }
});

export const roadmapRouter = router({
  roadmap: roadmapProcedure,
});
