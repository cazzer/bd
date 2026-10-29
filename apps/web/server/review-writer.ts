// Review decision write-back (board-visual-reviews, design.md decision 5):
// the board's one write, made through `bd` in the owning checkout so beads
// stays the record. The router (routers/review.ts) does the store-side
// refusals and the watcher wake; this module reads the tracker's own record,
// runs the tracker commands, and reports what landed.
//
// `bd` runs through `execFile` — argv, never a shell — in `cwd` = the
// registered checkout, with BEADS_DIR and BEADS_DB removed from its
// environment (either would send `bd` to another database than the
// checkout's). Each command gets 30 s; then SIGTERM, then SIGKILL after a
// 5 s grace, and 1 s after that the runner settles whether or not the
// output pipes have closed (a grandchild may hold them). There is no abort
// signal: a decision that has started is never cancelled from here. The comment text always starts with a fixed
// prefix (`Accepted` / `Changes requested`), so the argv element carrying a
// person's message can never be read by `bd` as a flag; the router also
// requires the item id to start with a letter or digit.
//
// The default runner's errors never include Node's `err.message`, which
// echoes the whole command line — the person's message included. They are
// `bd not found on PATH`, `could not start bd in <cwd>` (the checkout is
// gone), `bd <verb> timed out after 30 s`,
// `bd <verb> was killed (<signal>)`, `bd <verb> failed: <stderr>`, or
// `bd <verb> exited <code>`. A command that timed out or was killed may
// have done its work before it died: the runner throws `BdUncertainError`
// for those, and the writer reports that step as `uncertain` with "it may
// have been written".
//
// Before writing, `bd show <id> --json` reads the tracker's record (a
// pre-write step: it never appears in `written`). The store's copy can be
// stale or hand-written; the tracker is the record. The record must be the
// exact id asked for (bd resolves partial ids), labelled `review`, and not
// closed, or the decision is refused with `ReviewRecordRefusedError` and
// nothing is written. A failing `bd show` is reported like any tracker
// failure, with nothing attempted.
//
// Steps then run serially and stop at the first failure:
//   accept  → `comments add <id> <text>`, `update <id> --remove-label review:changes`,
//             `close <id> --reason "Review accepted"`
//   changes → `comments add <id> <text>`, `update <id> --add-label review:changes`
// Close is last so that a failed close leaves an open review the person can
// decide again (a closed one is refused). Accept removes `review:changes`
// unconditionally: `bd update --remove-label` on an issue without the label
// exits 0 and changes nothing (checked against bd while building this). The
// result names every step that completed; a failure after at least one is
// `partial`. `attempted` says whether any write command ran at all — the
// router wakes the watcher on it. A tracker failure is data in the result,
// never a throw.
//
// Concurrency: a second `write` for the same project/item while one is
// pending throws `ReviewDecisionInFlightError` before running anything; the
// key is claimed synchronously, before the first await, so two requests in
// the same tick cannot both pass. Writes to one checkout (any item) run one
// at a time through a per-`cwd` promise chain, so this server never runs two
// `bd` writers against one embedded database at once.
//
// bd-ker.5 adds the herdr notification beside `write`, not inside it.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Each `bd` command gets this long before SIGTERM. */
export const REVIEW_BD_TIMEOUT_MS = 30_000;
/** After SIGTERM, how long before SIGKILL. */
export const REVIEW_BD_KILL_GRACE_MS = 5_000;
/** After SIGKILL, how long before the runner gives up waiting for the output pipes to close. */
const REVIEW_BD_DEADLINE_SLACK_MS = 1_000;
/** `bd`'s output for these commands is small; this bounds what is buffered. */
const BD_MAX_BUFFER = 1024 * 1024;
/** Longest tracker error passed back to the browser. */
export const MAX_REVIEW_ERROR_LENGTH = 2000;

export const REVIEW_ACCEPT_REASON = "Review accepted";

export type ReviewDecision = "accept" | "changes";
export type ReviewStep = "comment" | "close" | "remove-changes-label" | "add-changes-label";

/** Runs `bd <args>` in `cwd` and resolves with stdout; rejects with an Error whose message is safe to show, a `BdUncertainError` when the command may have run. */
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
  /** Whether any write command ran (successfully or not). */
  attempted: boolean;
  /** The failing command's error; present only when `ok` is false. */
  error?: string;
  /** True when a step failed after another had already completed. Present only when `ok` is false. */
  partial?: boolean;
  /** A step that timed out or was killed and may have been written. */
  uncertain?: ReviewStep;
}

export interface ReviewWriter {
  write(input: ReviewWriteInput): Promise<ReviewWriteResult>;
}

export interface ReviewWriterOptions {
  /** Replaces the `bd` invocation (tests). */
  runBd?: RunBd;
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

export type ReviewRecordRefusal = "other-issue" | "not-review" | "closed";

/** The tracker's own record does not allow the decision; nothing was written. */
export class ReviewRecordRefusedError extends Error {
  constructor(
    readonly reason: ReviewRecordRefusal,
    readonly externalId: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewRecordRefusedError";
  }
}

/** The command may have done its work before it ended (timeout or signal). */
export class BdUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BdUncertainError";
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

export interface BdRunnerOptions {
  /** The executable; `bd` on PATH by default (tests point it at a stub). */
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** The default runner (module header): no shell, scrubbed env, SIGTERM then SIGKILL, errors that never echo argv. */
export function createBdRunner(options: BdRunnerOptions = {}): RunBd {
  const command = options.command ?? "bd";
  const timeoutMs = options.timeoutMs ?? REVIEW_BD_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? REVIEW_BD_KILL_GRACE_MS;
  const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} s` : `${(timeoutMs / 1000).toFixed(1)} s`;

  return (args, cwd) =>
    new Promise<string>((resolve, reject) => {
      const verb = `bd ${args[0] ?? ""}`.trim();
      const env = { ...process.env };
      delete env["BEADS_DIR"];
      delete env["BEADS_DB"];
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(deadline);
        settle();
      };
      const child = execFile(command, [...args], { cwd, env, maxBuffer: BD_MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) {
          finish(() => resolve(stdout));
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: string | number; signal?: NodeJS.Signals | null };
        if (e.code === "ENOENT") {
          // spawn reports a missing cwd as ENOENT too; say which it was.
          finish(() => reject(new Error(isDirectory(cwd) ? "bd not found on PATH" : `could not start bd in ${cwd}`)));
        } else if (timedOut) {
          finish(() => reject(new BdUncertainError(`${verb} timed out after ${seconds}`)));
        } else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          finish(() => reject(new BdUncertainError(`${verb} was stopped: too much output`)));
        } else if (e.signal) {
          finish(() => reject(new BdUncertainError(`${verb} was killed (${e.signal})`)));
        } else {
          const text = typeof stderr === "string" ? stderr.trim() : "";
          const message = text !== "" ? `${verb} failed: ${text}` : typeof e.code === "number" ? `${verb} exited ${e.code}` : `${verb} could not run (${String(e.code ?? "unknown error")})`;
          finish(() => reject(new Error(fitError(message))));
        }
      });
      const termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, timeoutMs);
      // `execFile` reports only once stdout/stderr close; a grandchild that
      // inherited them can hold them open after `bd` itself is dead. The
      // deadline settles regardless, so the per-checkout queue never wedges.
      const deadline = setTimeout(() => {
        finish(() => {
          child.kill("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          reject(new BdUncertainError(`${verb} timed out after ${seconds}`));
        });
      }, timeoutMs + killGraceMs + REVIEW_BD_DEADLINE_SLACK_MS);
    });
}

function stepsFor(input: ReviewWriteInput): Array<{ step: ReviewStep; args: string[] }> {
  const id = input.externalId;
  const comment = { step: "comment" as const, args: ["comments", "add", id, commentText(input.decision, input.message)] };
  if (input.decision === "accept") {
    return [
      comment,
      { step: "remove-changes-label", args: ["update", id, "--remove-label", "review:changes"] },
      { step: "close", args: ["close", id, "--reason", REVIEW_ACCEPT_REASON] },
    ];
  }
  return [comment, { step: "add-changes-label", args: ["update", id, "--add-label", "review:changes"] }];
}

function errorText(err: unknown): string {
  return fitError(err instanceof Error ? err.message : String(err));
}

/** `bd show --json` answers an array of one issue; a bare object is accepted too. */
function parseShownIssue(stdout: string): { id: unknown; status: unknown; labels: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const issue = Array.isArray(parsed) ? parsed[0] : parsed;
  return typeof issue === "object" && issue !== null ? (issue as { id: unknown; status: unknown; labels: unknown }) : null;
}

export function createReviewWriter(options: ReviewWriterOptions = {}): ReviewWriter {
  const runBd = options.runBd ?? createBdRunner();
  const inFlight = new Set<string>();
  const checkoutChains = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier write to the same checkout has settled. */
  function serialize<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const previous = checkoutChains.get(cwd) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.then(
      () => {},
      () => {},
    );
    checkoutChains.set(cwd, tail);
    void tail.then(() => {
      if (checkoutChains.get(cwd) === tail) checkoutChains.delete(cwd);
    });
    return next;
  }

  async function decide(input: ReviewWriteInput): Promise<ReviewWriteResult> {
    const id = input.externalId;
    let shown;
    try {
      shown = parseShownIssue(await runBd(["show", id, "--json"], input.cwd));
    } catch (err) {
      return { ok: false, written: [], attempted: false, error: errorText(err), partial: false };
    }
    if (shown === null) {
      return { ok: false, written: [], attempted: false, error: `bd show ${id} did not return an issue`, partial: false };
    }
    if (shown.id !== id) {
      throw new ReviewRecordRefusedError("other-issue", id, `The tracker resolves "${id}" to a different issue (${String(shown.id)}); nothing was written.`);
    }
    if (!Array.isArray(shown.labels) || !shown.labels.includes("review")) {
      throw new ReviewRecordRefusedError("not-review", id, `The tracker's record of "${id}" is not labelled "review"; nothing was written.`);
    }
    if (shown.status === "closed") {
      throw new ReviewRecordRefusedError("closed", id, `Review "${id}" is already closed in the tracker; nothing was written.`);
    }

    const written: ReviewStep[] = [];
    for (const { step, args } of stepsFor(input)) {
      try {
        await runBd(args, input.cwd);
      } catch (err) {
        const partial = written.length > 0;
        if (err instanceof BdUncertainError) {
          return { ok: false, written, attempted: true, uncertain: step, error: fitError(`${err.message}; it may have been written — check the tracker before deciding again`), partial };
        }
        return { ok: false, written, attempted: true, error: errorText(err), partial };
      }
      written.push(step);
    }
    return { ok: true, written, attempted: true };
  }

  return {
    async write(input) {
      const key = `${input.project}\0${input.externalId}`;
      if (inFlight.has(key)) throw new ReviewDecisionInFlightError(input.project, input.externalId);
      inFlight.add(key);
      try {
        return await serialize(input.cwd, () => decide(input));
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
