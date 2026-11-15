// Runs one claimed relay action and says how to report it (laptop-relay
// design.md decisions 2, 3, and 9; docs/relay.md "claim").
//
// The payload is parsed first, with core's own schema for its kind
// (`parseRelayPayload`, the one Breakdown ran at enqueue), and an action
// that breaks it is reported `failed` naming the field — before anything
// else, so a forged action spawns nothing. Then, per kind:
//
// - `review_decision`: the project must be in the registry at exactly the
//   payload's `cwd` (the registry is re-read once when it is not, in case
//   it was registered since), then the review writer runs it — the same
//   `createReviewWriter` the web server uses locally, with the relay's
//   allowlisted runners — so `bd show`'s check-then-act stays in one place.
//   `ok: true` → `done` with the writer's result; `ok: false` → `failed`
//   with its error and the result kept; an issue already closed → `done`
//   `{ note: "already applied", message }` (the decision ran before, and
//   its report was lost or reclaimed); any other refusal of the record →
//   `failed` with `{ refused: <reason> }`.
// - `herdr_prompt`: `agent prompt <pane> <text>` on the payload's socket →
//   `done { pane }`, or `failed` with herdr's (scrubbed) reason.
// - `beads_reingest`: the registry is re-read, then the project is
//   re-ingested and pushed now → `done { project, changed }`.
//
// It never throws: every outcome is a report. Nothing here logs; main.ts
// logs the action's id, kind, and state, never the payload.

import { InvalidRelayActionError, parseRelayPayload, type RelayActionKind, type ReviewDecisionPayload } from "@breakdown/core";
import { ReviewRecordRefusedError, type ReviewWriter, type ReviewWriteResult, type RunHerdr } from "../review-writer.js";
import type { RelayRegistry } from "./registry.js";

export type RelayReport =
  | { state: "done"; result: Record<string, unknown> }
  | { state: "failed"; error: string; result?: Record<string, unknown> };

export interface ClaimedAction {
  id: string;
  kind: unknown;
  payload: unknown;
}

export interface ExecuteDeps {
  registry: Pick<RelayRegistry, "get" | "refresh">;
  /** A writer whose runners are the relay's allowlisted ones (runners.ts `bdFor(project)`); made per project. */
  writerFor(project: string): ReviewWriter;
  /** The allowlisted herdr runner (runners.ts). */
  runHerdr: RunHerdr;
  /** Re-ingests one registry project and pushes it (push.ts / the watcher). */
  reingest(project: string): Promise<{ changed: boolean }>;
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
      if (err.reason === "closed") return { state: "done", result: { note: "already applied", message: err.message } };
      return { state: "failed", error: err.message, result: { refused: err.reason } };
    }
    return { state: "failed", error: message(err) };
  }
  if (written.ok) return { state: "done", result: resultOf(written) };
  return { state: "failed", error: written.error ?? "the decision was not written", result: resultOf(written) };
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
  if (report.error.startsWith("refused:")) return "failed (refused before running)";
  const refused = report.result?.["refused"];
  return typeof refused === "string" ? `failed (the tracker's record refused it: ${refused})` : "failed";
}
