// Runs one claimed relay action and says how to report it (laptop-relay
// design.md decisions 2, 3, and 9; docs/relay.md "claim").
//
// The payload is parsed first, with core's own schema for its kind
// (`parseRelayPayload`, the one Breakdown ran at enqueue), and an action
// that breaks it is reported `failed` naming the field — before anything
// else, so a malformed action spawns nothing. That bounds the action's
// shape only; what bounds where it runs is the relay's own configuration.
// Then two more refusals before anything runs: a kind this relay does not
// claim (`--kinds`; Breakdown should not have handed it out), and a review
// decision or herdr prompt whose `created_at` is older than `--max-age`
// (24 h by default; a missing or unreadable `created_at` counts as too
// old). A re-ingest is never stale. Then, per kind:
//
// - `review_decision`: the project must be in the registry at exactly the
//   payload's `cwd` (the registry is re-read once when it is not, in case
//   it was registered since), then the review writer runs it — the same
//   `createReviewWriter` the web server uses locally, with the relay's
//   allowlisted runners — so `bd show`'s check-then-act stays in one place.
//   `ok: true` → `done` with the writer's result; `ok: false` → `failed`
//   with its error and the result kept; an accept on an issue already
//   closed → `done` `{ note: "already applied", message }` (the decision
//   ran before, and its report was lost or reclaimed); a request for
//   changes on a closed issue → `failed` (`refused: the review is
//   closed`), since it never closes one; any other refusal of the record →
//   `failed` with `{ refused: <reason> }`.
// - `herdr_prompt`: `agent prompt <pane> <text>` on the payload's socket →
//   `done { pane }`, or `failed` with herdr's (scrubbed) reason.
// - `beads_reingest`: the registry is re-read, then the project is
//   re-ingested and pushed now → `done { project, changed }`.
// - `review_request` (hangar-driver-decisions: a driver's escalation): the
//   project must be in the registry at the payload's `cwd`, as for a
//   decision; then, with the relay's allowlisted `bd`, the work item is
//   read (`show`), its open reviews listed, and the one whose `review.key`
//   is the payload's reused, else one created under it; its `review`
//   metadata is set, and a new review is made to block the work item
//   (unless it is an epic, which bd forbids). → `done { review_id, reused }`,
//   or `failed` naming the step, with `review_id` kept once one exists. The
//   key makes a retry after a lost report find the review it filed rather
//   than file another. The project is then re-ingested, best-effort, so the
//   board shows the review at once. Never stale, like a re-ingest.
// - `review_withdraw` (a review filed after its decision moved on): the
//   same registry check, then `bd show` the review; it must be that exact
//   issue, labelled `review`. An open one is closed with the payload's reason
//   (a closed review blocks nothing) → `done { review_id, closed: true }`;
//   one already closed → `done { review_id, closed: false, note }`. Never
//   stale.
//
// It never throws: every outcome is a report. Nothing here logs; main.ts
// logs the action's id, kind, and state, never the payload.

import {
  InvalidRelayActionError,
  parseRelayPayload,
  RELAY_ACTION_KINDS,
  RELAY_MAX_AGE_S,
  relayReviewCreateArgs,
  relayReviewListArgs,
  type RelayActionKind,
  type ReviewDecisionPayload,
  type ReviewRequestPayload,
  type ReviewWithdrawPayload,
} from "@breakdown/core";
import { ReviewRecordRefusedError, type ReviewWriter, type ReviewWriteResult, type RunBd, type RunHerdr } from "../review-writer.js";
import type { RelayRegistry } from "./registry.js";

export type RelayReport =
  | { state: "done"; result: Record<string, unknown> }
  | { state: "failed"; error: string; result?: Record<string, unknown> };

export interface ClaimedAction {
  id: string;
  kind: unknown;
  payload: unknown;
  /** The claim's `created_at`, as the server sent it. */
  createdAt: unknown;
}

export interface ExecuteDeps {
  registry: Pick<RelayRegistry, "get" | "refresh">;
  /** A writer whose runners are the relay's allowlisted ones (runners.ts `bdFor(project)`); made per project. */
  writerFor(project: string): ReviewWriter;
  /** The relay's allowlisted `bd` for `project` (runners.ts `bdFor`), for filing a review; without it a review request is refused. */
  bdFor?(project: string): RunBd;
  /** The allowlisted herdr runner (runners.ts). */
  runHerdr: RunHerdr;
  /** Re-ingests one registry project and pushes it (push.ts / the watcher). */
  reingest(project: string): Promise<{ changed: boolean }>;
  /** `--kinds`: the kinds this relay runs; every kind by default. */
  kinds?: readonly RelayActionKind[];
  /** `--max-age` in milliseconds; 24 h by default. */
  maxAgeMs?: number;
  /** The relay's clock (tests). */
  now?: () => number;
}

/** Why a review decision or herdr prompt is too old to run, or null (module header). */
function staleness(createdAt: unknown, maxAgeMs: number, now: number): string | null {
  const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(at)) return "refused: the action carries no readable created_at, so its age is unknown; nothing ran";
  if (now - at > maxAgeMs) return `refused: stale: queued ${new Date(at).toISOString()}, older than this relay's --max-age (${formatAge(maxAgeMs)}); nothing ran`;
  return null;
}

function formatAge(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) if (ms % size === 0) return `${ms / size} ${unit}`;
  return `${Math.round(ms / 1000)} s`;
}

function message(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : String(err);
}

function resultOf(written: ReviewWriteResult): Record<string, unknown> {
  return { ...written };
}

async function inRegistry(deps: ExecuteDeps, project: string): Promise<{ project: string; dir: string } | undefined> {
  const entry = deps.registry.get(project);
  if (entry !== undefined) return entry;
  try {
    await deps.registry.refresh();
  } catch {
    // The refusal below says what is missing; the refresh failure is the server's to report next time.
  }
  return deps.registry.get(project);
}

async function reviewDecision(deps: ExecuteDeps, payload: ReviewDecisionPayload): Promise<RelayReport> {
  const entry = await inRegistry(deps, payload.project_key);
  if (entry === undefined) return { state: "failed", error: `refused: project ${payload.project_key} is not in this relay's registry; nothing ran` };
  if (entry.dir !== payload.cwd) {
    return { state: "failed", error: `refused: ${payload.cwd} is not project ${payload.project_key}'s checkout in this relay's registry (${entry.dir}); nothing ran` };
  }
  let written: ReviewWriteResult;
  try {
    written = await deps.writerFor(payload.project_key).write({
      project: payload.project_key,
      cwd: payload.cwd,
      externalId: payload.issue_id,
      decision: payload.decision,
      message: payload.message.trim(),
      ...(payload.option === undefined ? {} : { option: payload.option }),
      ...(payload.seen === undefined ? {} : { seen: payload.seen }),
    });
  } catch (err) {
    if (err instanceof ReviewRecordRefusedError) {
      // Only an accept closes the issue, so only an accept can find its own earlier run already applied.
      if (err.reason === "closed" && payload.decision === "accept") return { state: "done", result: { note: "already applied", message: err.message } };
      if (err.reason === "closed") return { state: "failed", error: "refused: the review is closed", result: { refused: err.reason } };
      return { state: "failed", error: err.message, result: { refused: err.reason } };
    }
    return { state: "failed", error: message(err) };
  }
  if (written.ok) return { state: "done", result: resultOf(written) };
  return { state: "failed", error: written.error ?? "the decision was not written", result: resultOf(written) };
}

/** One record from `bd show` / `bd create` JSON (an array of one, or the object). */
function firstRecord(stdout: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(stdout);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  return record !== null && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : null;
}

function reviewKeyOf(record: unknown): string | null {
  const review = (record as { metadata?: { review?: { key?: unknown } } } | null)?.metadata?.review;
  return typeof review?.key === "string" ? review.key : null;
}

async function reviewRequest(deps: ExecuteDeps, payload: ReviewRequestPayload): Promise<RelayReport> {
  if (deps.bdFor === undefined) return { state: "failed", error: "refused: this relay cannot file reviews; nothing ran" };
  const entry = await inRegistry(deps, payload.project_key);
  if (entry === undefined) return { state: "failed", error: `refused: project ${payload.project_key} is not in this relay's registry; nothing ran` };
  if (entry.dir !== payload.cwd) {
    return { state: "failed", error: `refused: ${payload.cwd} is not project ${payload.project_key}'s checkout in this relay's registry (${entry.dir}); nothing ran` };
  }
  const bd = deps.bdFor(payload.project_key);
  const key = typeof payload.review["key"] === "string" ? payload.review["key"] : null;
  let reviewId: string | null = null;
  let step = "bd show";
  try {
    const item = firstRecord(await bd(["show", payload.issue_id, "--json"], payload.cwd));
    if (item === null || item["id"] !== payload.issue_id) return { state: "failed", error: `refused: bd show ${payload.issue_id} returned another issue or nothing; nothing was filed` };
    step = "bd list";
    const children: unknown = JSON.parse(await bd(relayReviewListArgs(payload.issue_id), payload.cwd));
    const existing = Array.isArray(children)
      ? children
          .filter((c) => key !== null && reviewKeyOf(c) === key && typeof (c as { id?: unknown }).id === "string")
          .sort((a, b) => String((b as { created_at?: unknown }).created_at ?? "").localeCompare(String((a as { created_at?: unknown }).created_at ?? "")))[0]
      : undefined;
    const reused = existing !== undefined;
    if (reused) {
      reviewId = (existing as { id: string }).id;
    } else {
      step = "bd create";
      const created = firstRecord(await bd(relayReviewCreateArgs({ title: payload.title, parent: payload.issue_id, description: payload.description }), payload.cwd));
      const id = created?.["id"];
      if (typeof id !== "string") return { state: "failed", error: `bd create ran but printed no issue id; check the open reviews of ${payload.issue_id} before retrying` };
      reviewId = id;
    }
    step = "bd update";
    await bd(["update", reviewId, "--metadata", JSON.stringify({ review: payload.review })], payload.cwd);
    if (!reused && item["issue_type"] !== "epic") {
      step = "bd dep add";
      await bd(["dep", "add", payload.issue_id, reviewId, "--type", "blocks"], payload.cwd);
    }
    // Best-effort: the board shows the review now rather than at the watcher's next change.
    await deps.reingest(payload.project_key).catch(() => undefined);
    return { state: "done", result: { review_id: reviewId, reused } };
  } catch (err) {
    return { state: "failed", error: `${step} failed: ${message(err)}`, ...(reviewId === null ? {} : { result: { review_id: reviewId } }) };
  }
}

async function reviewWithdraw(deps: ExecuteDeps, payload: ReviewWithdrawPayload): Promise<RelayReport> {
  if (deps.bdFor === undefined) return { state: "failed", error: "refused: this relay cannot withdraw reviews; nothing ran" };
  const entry = await inRegistry(deps, payload.project_key);
  if (entry === undefined) return { state: "failed", error: `refused: project ${payload.project_key} is not in this relay's registry; nothing ran` };
  if (entry.dir !== payload.cwd) {
    return { state: "failed", error: `refused: ${payload.cwd} is not project ${payload.project_key}'s checkout in this relay's registry (${entry.dir}); nothing ran` };
  }
  const bd = deps.bdFor(payload.project_key);
  let step = "bd show";
  try {
    const review = firstRecord(await bd(["show", payload.issue_id, "--json"], payload.cwd));
    const labels = Array.isArray(review?.["labels"]) ? (review!["labels"] as unknown[]) : [];
    if (review === null || review["id"] !== payload.issue_id || !labels.includes("review")) {
      return { state: "failed", error: `refused: ${payload.issue_id} is not a review in project ${payload.project_key}; nothing was closed` };
    }
    if (review["status"] === "closed") return { state: "done", result: { review_id: payload.issue_id, closed: false, note: "already closed" } };
    step = "bd close";
    await bd(["close", payload.issue_id, "--reason", payload.reason], payload.cwd);
    await deps.reingest(payload.project_key).catch(() => undefined);
    return { state: "done", result: { review_id: payload.issue_id, closed: true } };
  } catch (err) {
    return { state: "failed", error: `${step} failed: ${message(err)}` };
  }
}

export async function executeAction(action: ClaimedAction, deps: ExecuteDeps): Promise<RelayReport> {
  let kind: RelayActionKind;
  let payload: unknown;
  try {
    payload = parseRelayPayload(action.kind, action.payload);
    kind = action.kind as RelayActionKind;
  } catch (err) {
    const reason = err instanceof InvalidRelayActionError ? err.message : message(err);
    return { state: "failed", error: `refused: ${reason}; nothing ran` };
  }
  if (!(deps.kinds ?? RELAY_ACTION_KINDS).includes(kind)) {
    return { state: "failed", error: `refused: this relay does not run ${kind} actions (--kinds); nothing ran` };
  }
  if (kind !== "beads_reingest" && kind !== "review_request" && kind !== "review_withdraw") {
    const stale = staleness(action.createdAt, deps.maxAgeMs ?? RELAY_MAX_AGE_S * 1000, (deps.now ?? Date.now)());
    if (stale !== null) return { state: "failed", error: stale };
  }

  switch (kind) {
    case "review_decision":
      return reviewDecision(deps, payload as ReviewDecisionPayload);
    case "herdr_prompt": {
      const { pane, socket, text } = payload as { pane: string; socket: string; text: string };
      try {
        await deps.runHerdr(["agent", "prompt", pane, text], socket);
        return { state: "done", result: { pane } };
      } catch (err) {
        return { state: "failed", error: message(err) };
      }
    }
    case "review_request":
      return reviewRequest(deps, payload as ReviewRequestPayload);
    case "review_withdraw":
      return reviewWithdraw(deps, payload as ReviewWithdrawPayload);
    case "beads_reingest": {
      const { project_key: project } = payload as { project_key: string };
      try {
        await deps.registry.refresh();
      } catch {
        // A stale registry still answers below; a project it lacks is refused.
      }
      if (deps.registry.get(project) === undefined) return { state: "failed", error: `refused: project ${project} is not in this relay's registry; nothing ran` };
      try {
        const { changed } = await deps.reingest(project);
        return { state: "done", result: { project, changed } };
      } catch (err) {
        return { state: "failed", error: message(err) };
      }
    }
  }
}

/** For the log: what kind of refusal or failure, never the payload text. */
export function reportSummary(report: RelayReport): string {
  if (report.state === "done") return "done";
  const refused = report.result?.["refused"];
  if (typeof refused === "string") return `failed (the tracker's record refused it: ${refused})`;
  return report.error.startsWith("refused:") ? "failed (refused before running)" : "failed";
}
