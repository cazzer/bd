// Review decision write-back (board-visual-reviews, design.md decision 5):
// the board's one write, made through `bd` in the owning checkout so beads
// stays the record. The router (routers/review.ts) does every refusal and
// the watcher wake; this module only runs the tracker commands and reports
// what landed.
//
// `bd` runs through `execFile` — argv, never a shell — in `cwd` = the
// registered checkout, with a 30 s hard timeout (SIGKILL) and no abort
// signal: a decision that has started is never cancelled from here, so the
// only way a step ends early is the tracker refusing it or the timeout.
// The comment text always starts with a fixed prefix (`Accepted` /
// `Changes requested`), so the argv element carrying a person's message can
// never be read by `bd` as a flag, whatever the message is; the item id is
// validated by the router to start with a letter or digit for the same
// reason.
//
// Steps run serially and stop at the first failure:
//   accept  → `comments add <id> <text>`, `close <id> --reason "Review accepted"`,
//             `update <id> --remove-label review:changes`
//   changes → `comments add <id> <text>`, `update <id> --add-label review:changes`
// Accept removes `review:changes` unconditionally: `bd update --remove-label`
// on an issue without the label exits 0 and changes nothing (open or
// closed; checked against bd while building this), so there is no label
// read to go stale. The result names every step that completed; a failure
// after at least one step is `partial` — the comment is in the tracker and
// the person must know that before retrying. A tracker failure is data in
// the result, never a throw.
//
// One decision per item at a time: a second `write` for the same
// project/item while one is running throws `ReviewDecisionInFlightError`
// before running anything. The key is claimed synchronously, before the
// first await, so two requests in the same tick cannot both pass.
//
// bd-ker.5 adds the herdr notification beside `write`, not inside it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hard limit on one `bd` invocation; the process is SIGKILLed after it. */
export const REVIEW_BD_TIMEOUT_MS = 30_000;
/** `bd`'s output for these commands is a line or two; anything near this is not a reply we read. */
const BD_MAX_BUFFER = 1024 * 1024;
/** Longest tracker error passed back to the browser. */
export const MAX_REVIEW_ERROR_LENGTH = 2000;

export const REVIEW_ACCEPT_REASON = "Review accepted";

export type ReviewDecision = "accept" | "changes";
export type ReviewStep = "comment" | "close" | "remove-changes-label" | "add-changes-label";

/** Runs `bd <args>` in `cwd` and resolves with stdout; rejects with an Error whose message is safe to show. */
export type RunBd = (args: readonly string[], cwd: string) => Promise<string>;

export interface ReviewWriteInput {
  /** The registered project key; with `externalId`, the in-flight key. */
  project: string;
  /** The registered checkout `bd` runs in. */
  cwd: string;
  /** The review bead's id. */
  externalId: string;
  decision: ReviewDecision;
  /** Already trimmed; may be empty for `accept`. */
  message: string;
}

export interface ReviewWriteResult {
  ok: boolean;
  /** Steps that completed, in order. */
  written: ReviewStep[];
  /** The failing step's error; present only when `ok` is false. */
  error?: string;
  /** True when a step failed after another had already completed. Present only when `ok` is false. */
  partial?: boolean;
}

export interface ReviewWriter {
  write(input: ReviewWriteInput): Promise<ReviewWriteResult>;
}

export interface ReviewWriterOptions {
  /** Replaces the `bd` invocation (tests). */
  runBd?: RunBd;
  /** The default runner's per-command timeout. */
  timeoutMs?: number;
}

export class ReviewDecisionInFlightError extends Error {
  constructor(
    readonly project: string,
    readonly externalId: string,
  ) {
    super(`A decision on ${externalId} (${project}) is already being written; wait for it to finish.`);
    this.name = "ReviewDecisionInFlightError";
  }
}

function fitError(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_REVIEW_ERROR_LENGTH ? `${trimmed.slice(0, MAX_REVIEW_ERROR_LENGTH - 1)}…` : trimmed;
}

/** The comment written for a decision. The fixed prefix keeps the argv element from ever starting with `-`. */
export function commentText(decision: ReviewDecision, message: string): string {
  const m = message.trim();
  if (decision === "accept") return m === "" ? "Accepted." : `Accepted: ${m}`;
  return `Changes requested: ${m}`;
}

/** The default runner. The error names the verb only — never the arguments, which carry the person's message. */
function createDefaultRunBd(timeoutMs: number): RunBd {
  return async (args, cwd) => {
    try {
      const { stdout } = await execFileAsync("bd", [...args], { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: BD_MAX_BUFFER });
      return stdout;
    } catch (err) {
      const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(fitError(`bd ${args[0] ?? ""} failed: ${stderr || message}`));
    }
  };
}

function stepsFor(input: ReviewWriteInput): Array<{ step: ReviewStep; args: string[] }> {
  const id = input.externalId;
  const comment = { step: "comment" as const, args: ["comments", "add", id, commentText(input.decision, input.message)] };
  if (input.decision === "accept") {
    return [
      comment,
      { step: "close", args: ["close", id, "--reason", REVIEW_ACCEPT_REASON] },
      { step: "remove-changes-label", args: ["update", id, "--remove-label", "review:changes"] },
    ];
  }
  return [comment, { step: "add-changes-label", args: ["update", id, "--add-label", "review:changes"] }];
}

export function createReviewWriter(options: ReviewWriterOptions = {}): ReviewWriter {
  const runBd = options.runBd ?? createDefaultRunBd(options.timeoutMs ?? REVIEW_BD_TIMEOUT_MS);
  const inFlight = new Set<string>();

  return {
    async write(input) {
      const key = `${input.project}\0${input.externalId}`;
      if (inFlight.has(key)) throw new ReviewDecisionInFlightError(input.project, input.externalId);
      inFlight.add(key);
      try {
        const written: ReviewStep[] = [];
        for (const { step, args } of stepsFor(input)) {
          try {
            await runBd(args, input.cwd);
          } catch (err) {
            return { ok: false, written, error: fitError(err instanceof Error ? err.message : String(err)), partial: written.length > 0 };
          }
          written.push(step);
        }
        return { ok: true, written };
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
