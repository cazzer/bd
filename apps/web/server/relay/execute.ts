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
//   A decision carrying `images` (review-decision-images, design.md
//   decision 5) first downloads each one through `fetchImage` (the media
//   endpoint) into `<mediaDir>/<action id>/`, each written to a temporary
//   name and renamed; a directory left by an earlier claim of the same
//   action is replaced. Any failure removes that directory and reports
//   `failed: could not fetch image <n>: <reason>` with nothing written.
//   The writer then records the payload's relative paths in the comment and
//   names the downloaded files in the prompt.
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
//
// It never throws: every outcome is a report. Nothing here logs; main.ts
// logs the action's id, kind, and state, never the payload.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { InvalidRelayActionError, parseRelayPayload, RELAY_ACTION_KINDS, RELAY_MAX_AGE_S, type RelayActionKind, type ReviewDecisionPayload } from "@breakdown/core";
import { ReviewRecordRefusedError, type ReviewWriter, type ReviewWriteResult, type RunHerdr } from "../review-writer.js";
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
  /** `--media-dir`: where a decision's images are downloaded, one directory per action (module header). */
  mediaDir?: string;
  /** Fetches image `n` of claimed action `id` (client.get on the media endpoint); rejects with a reason safe to log. */
  fetchImage?(id: string, n: number): Promise<Uint8Array>;
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

/** Downloads a decision's images into `<mediaDir>/<id>/`, or says which failed, leaving nothing behind (module header). */
async function downloadImages(deps: ExecuteDeps, id: string, images: readonly string[]): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  if (deps.mediaDir === undefined || deps.fetchImage === undefined) return { ok: false, error: "refused: this relay cannot download decision images (no --media-dir); nothing ran" };
  if (!/^[1-9]\d{0,17}$/.test(id)) return { ok: false, error: "refused: the action id is not a decimal id; nothing ran" };
  const dir = path.join(deps.mediaDir, id);
  const files: string[] = [];
  let n = 0;
  try {
    await mkdir(deps.mediaDir, { recursive: true, mode: 0o700 });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
    for (; n < images.length; n += 1) {
      const base = path.posix.basename(images[n]!);
      const name = files.some((f) => path.basename(f) === base) ? `${n}-${base}` : base;
      const bytes = await deps.fetchImage(id, n);
      const target = path.join(dir, name);
      const tmp = path.join(dir, `.${name}.tmp`);
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, target);
      files.push(target);
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `could not fetch image ${n}: ${message(err)}` };
  }
  return { ok: true, files };
}

async function reviewDecision(deps: ExecuteDeps, payload: ReviewDecisionPayload, actionId: string): Promise<RelayReport> {
  const entry = await inRegistry(deps, payload.project_key);
  if (entry === undefined) return { state: "failed", error: `refused: project ${payload.project_key} is not in this relay's registry; nothing ran` };
  if (entry.dir !== payload.cwd) {
    return { state: "failed", error: `refused: ${payload.cwd} is not project ${payload.project_key}'s checkout in this relay's registry (${entry.dir}); nothing ran` };
  }
  let images: { imagePaths: readonly string[]; imageFiles: readonly string[] } | null = null;
  if (payload.images !== undefined && payload.images.length > 0) {
    const downloaded = await downloadImages(deps, actionId, payload.images);
    if (!downloaded.ok) return { state: "failed", error: downloaded.error };
    images = { imagePaths: payload.images, imageFiles: downloaded.files };
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
      ...(images === null ? {} : images),
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
  if (kind !== "beads_reingest") {
    const stale = staleness(action.createdAt, deps.maxAgeMs ?? RELAY_MAX_AGE_S * 1000, (deps.now ?? Date.now)());
    if (stale !== null) return { state: "failed", error: stale };
  }

  switch (kind) {
    case "review_decision":
      return reviewDecision(deps, payload as ReviewDecisionPayload, action.id);
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
  const refused = report.result?.["refused"];
  if (typeof refused === "string") return `failed (the tracker's record refused it: ${refused})`;
  return report.error.startsWith("refused:") ? "failed (refused before running)" : "failed";
}
