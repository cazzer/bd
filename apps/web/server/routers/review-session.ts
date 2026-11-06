// Drilling into a review (review-sessions): `reviewSession` either brings
// the requesting agent's herdr pane to the front ("focus") or opens a new
// tab with an agent primed on the review ("open"), in the project's
// registered checkout. It writes nothing — not to the tracker, not to the
// store. The decision still goes through `reviewDecision`, the board's one
// write; the prompt says so.
//
// Refusals, before any command runs:
//   1. no herdr runner, or (for "open") no herdr socket       → PRECONDITION_FAILED
//   2. "open" on a read-only server (BRAIN_READ_ONLY)           → FORBIDDEN
//   3. no checkout registered by a beads ingest for the key    → NOT_FOUND
//   4. the project holds no such item                          → NOT_FOUND
//   5. the item is not a readable review                       → PRECONDITION_FAILED
//   6. "focus" on a review with no pane and socket recorded    → PRECONDITION_FAILED
// herdr's own failure (the pane is gone, the agent would not start) comes
// back as `{ ok: false, reason }`, data rather than an error, like a failed
// review notification.

import { stat } from "node:fs/promises";
import { getBoardItem, getRegisteredBeadsProject, PROJECT_KEY_PATTERN, reviewCard, type ReviewMetadata } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { focusPane, openAgentSession } from "../herdr-session.js";
import { publicProcedure, router } from "../trpc.js";
import { REVIEW_ITEM_ID_PATTERN } from "./review.js";

export const REVIEW_SESSION_WORKSPACE = "reviews";
/** The evidence put in the prompt; the agent reads the rest with `bd show`. */
const MAX_PROMPT_EVIDENCE = 4000;

export const reviewSessionInputSchema = z.object({
  project: z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`),
  item: z.string().regex(REVIEW_ITEM_ID_PATTERN, "must be a bead id"),
  mode: z.enum(["focus", "open"]),
});

export type ReviewSessionResult = { ok: true; mode: "focus" | "open"; tab: string; pane?: string } | { ok: false; mode: "focus" | "open"; reason: string };

/** The opening prompt of a session on a review: the card, where to read more, and that the board takes the decision. */
export function reviewSessionPrompt(input: { project: string; externalId: string; title: string; description: string; review: ReviewMetadata }): string {
  const card = reviewCard(input.review);
  const evidence = input.description.trim();
  const lines = [
    `I want to think through review ${input.externalId} (project ${input.project}) with you before I decide: "${input.title}"`,
    "",
    `Question: ${card.question}`,
  ];
  if (card.options.length > 0) {
    lines.push("Options:");
    for (const o of card.options) {
      const rec = o.id === card.recommend ? " (recommended)" : "";
      lines.push(`- ${o.id}: ${o.label}${rec}${o.what ? ` — ${o.what}` : ""}${o.risk ? ` Risk: ${o.risk}` : ""}`);
    }
  }
  if (card.onAccept.length > 0) lines.push(`On accept, the requesting agent will: ${card.onAccept.join("; ")}`);
  if (evidence !== "") {
    lines.push("", "Evidence:", evidence.length > MAX_PROMPT_EVIDENCE ? `${evidence.slice(0, MAX_PROMPT_EVIDENCE)}… (cut; \`bd show ${input.externalId}\` has all of it)` : evidence);
  }
  if (input.review.pane !== null) lines.push("", `The agent that asked is in herdr pane ${input.review.pane}; read its output with \`herdr pane read ${input.review.pane}\` if it helps, but don't prompt it.`);
  lines.push(
    "",
    `Start with \`bd show ${input.externalId}\` and \`bd comments ${input.externalId}\`, look at whatever the review touches, and tell me what you see and what you'd pick and why. Then help me poke at it.`,
    "Don't decide the review or comment on the bead yourself: I'll decide it in the board, and that notifies the requesting agent.",
  );
  return lines.join("\n");
}

const reviewSessionProcedure = publicProcedure.input(reviewSessionInputSchema).mutation(async ({ ctx, input }): Promise<ReviewSessionResult> => {
  const run = ctx.herdrJson;
  if (run === undefined) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This server has no herdr runner configured; review sessions are unavailable." });
  if (input.mode === "open" && ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); opening a session is refused." });
  if (input.mode === "open" && (ctx.herdrSocket === undefined || ctx.herdrSocket === null)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No herdr session found for the server. Start `pnpm dev` inside herdr, or keep herdr's default socket, and try again." });
  }

  let project;
  let item;
  try {
    project = await getRegisteredBeadsProject(ctx.db, input.project);
    item = project === null ? null : await getBoardItem(ctx.db, { project: input.project, externalId: input.item });
  } catch (err) {
    throw mapCoreError("reviewDecision", err);
  }
  if (project === null) throw new TRPCError({ code: "NOT_FOUND", message: `Project "${input.project}" has no checkout registered by a beads ingest.` });
  if (item === null) throw new TRPCError({ code: "NOT_FOUND", message: `Item "${input.item}" is not in project "${input.project}".` });
  const review = item.review;
  if (!item.isReview || review === null || "invalid" in review) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Item "${input.item}" is not a review that could be read.` });
  }

  if (input.mode === "focus") {
    if (review.pane === null || review.socket === undefined) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Review "${input.item}" recorded no herdr pane and session, so there is no requesting agent to go to.` });
    }
    try {
      const { tab } = await focusPane(run, review.socket, review.pane);
      return { ok: true, mode: "focus", tab, pane: review.pane };
    } catch (err) {
      return { ok: false, mode: "focus", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  let cwd = project.path;
  try {
    if (!(await stat(cwd)).isDirectory()) cwd = process.cwd();
  } catch {
    cwd = process.cwd();
  }
  try {
    const opened = await openAgentSession(run, ctx.herdrSocket!, {
      workspaceLabel: REVIEW_SESSION_WORKSPACE,
      title: `${item.externalId} ${item.title}`,
      cwd,
      prompt: reviewSessionPrompt({ project: input.project, externalId: item.externalId, title: item.title, description: item.content, review }),
      namePrefix: `review-${item.externalId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 18)}`,
    });
    return { ok: true, mode: "open", tab: opened.tab, pane: opened.pane };
  } catch (err) {
    return { ok: false, mode: "open", reason: err instanceof Error ? err.message : String(err) };
  }
});

export const reviewSessionRouter = router({
  reviewSession: reviewSessionProcedure,
});
