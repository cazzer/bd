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
// Notification (design.md decision 6): once every step has been written
// (`ok: true`), the requesting agent's pane is told with `herdr agent prompt
// <pane> <text>` — `Review <id> accepted: <message>` (`Review <id>
// accepted.` with no message) or `Review <id> changes requested: <message>`.
// The text always starts with `Review`, so it is never read as a flag.
// herdr 0.9.1 does not accept `--` before positionals (it answers "unknown
// option"), so none is passed; the pane pattern is what keeps the pane from
// being read as a flag.
//
// The recipient is `metadata.review.pane` and `metadata.review.socket` on
// the tracker record the pre-write `bd show` returned — never the request's
// and never the store's, because any agent can write a store node through
// `brain_write`. The pane must match REVIEW_PANE_PATTERN (a letter or digit
// first). Pane ids are scoped to one herdr server, so herdr runs with
// HERDR_SOCKET_PATH set to the recorded socket (the rest of the environment
// inherited); a socket that is missing, not absolute, over-long, carries a
// control character, or is not a socket on disk means no call, with "the
// pane's herdr session is unknown" — prompting through this server's own
// herdr could reach another session's pane of the same id.
//
// A partial, uncertain, or failed write notifies nobody: `notified` is
// `{ ok: false, reason: "the decision was not fully written" }`. The comment
// in the tracker is the record, and an agent told "accepted" about a review
// that is still open would act on a decision that did not land. After the
// bd steps the checkout's write queue is released, then `onWritten` runs
// (the router wakes the watcher there, so the board does not wait on
// herdr), then the notification; the in-flight claim is held throughout.
// The notification never fails or undoes the decision: its outcome is
// `{ ok: true, pane }` or `{ ok: false, reason }`, and every `ok: false` is
// logged with the project and bead id.
//
// `herdr` is found on PATH and runs through `execFile` with argv only and no
// `--wait`: 10 s, then SIGTERM, then SIGKILL after a 5 s grace, settling 1 s
// later whether or not the pipes have closed, like the bd runner. Its
// reasons are `herdr not found on PATH`, `herdr timed out after 10 s; the
// agent may have been notified`, `herdr was killed (<signal>)`, herdr's own
// error (it prints `{"error":{"code","message"}}` on stderr; message and
// code are kept, nothing else), or `herdr exited <code>`. Node's
// `err.message` (which echoes argv) is never used. herdr's own output is the
// only text that could carry the prompt back, so it alone is scrubbed: the
// trimmed prompt, and each trimmed prompt line of 8+ characters, is cut out.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isReviewSocketPath, REVIEW_PANE_PATTERN } from "@breakdown/core";

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
/** `herdr agent prompt` gets this long before SIGTERM. */
export const REVIEW_HERDR_TIMEOUT_MS = 10_000;
/** Longest notification failure reason passed back to the browser. */
export const MAX_NOTIFY_REASON_LENGTH = 300;

export const REVIEW_ACCEPT_REASON = "Review accepted";

export type ReviewDecision = "accept" | "changes";
export type ReviewStep = "comment" | "close" | "remove-changes-label" | "add-changes-label";

/** Runs `bd <args>` in `cwd` and resolves with stdout; rejects with an Error whose message is safe to show, a `BdUncertainError` when the command may have run. */
export type RunBd = (args: readonly string[], cwd: string) => Promise<string>;

/** Runs `herdr <args>` against the herdr server at `socket` (HERDR_SOCKET_PATH); resolves on exit 0, rejects with an Error whose message is a short reason safe to show. */
export type RunHerdr = (args: readonly string[], socket: string) => Promise<void>;

/** Whether the requesting pane was told the decision. */
export type ReviewNotified = { ok: true; pane: string } | { ok: false; reason: string };

export const NOTIFY_NO_PANE = "no pane recorded on the review";
export const NOTIFY_INVALID_PANE = "pane id is not valid";
export const NOTIFY_UNKNOWN_SESSION = "the pane's herdr session is unknown";
export const NOTIFY_NOT_WRITTEN = "the decision was not fully written";

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
  /** Called once the bd steps are over and the checkout's queue is released, before the notification (module header). */
  onWritten?: (outcome: { ok: boolean; attempted: boolean }) => void;
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
  /** The pane notification; `{ ok: false, reason: NOTIFY_NOT_WRITTEN }` when the decision was not fully written, so nobody was told. */
  notified: ReviewNotified;
}

export interface ReviewWriter {
  write(input: ReviewWriteInput): Promise<ReviewWriteResult>;
}

export interface ReviewWriterOptions {
  /** Replaces the `bd` invocation (tests). */
  runBd?: RunBd;
  /** Replaces the `herdr` invocation (tests). */
  runHerdr?: RunHerdr;
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

/** The prompt sent to the requesting pane. Starts with `Review`, never `-`. */
export function notifyText(decision: ReviewDecision, id: string, message: string): string {
  const m = message.trim();
  if (decision === "accept") return m === "" ? `Review ${id} accepted.` : `Review ${id} accepted: ${m}`;
  return `Review ${id} changes requested: ${m}`;
}

function isSocketOnDisk(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** The recipient on a tracker record (`metadata.review.pane` and `.socket`), or why there is none to prompt (module header). */
export function recipientOf(record: { metadata?: unknown }): { pane: string; socket: string } | { reason: string } {
  const metadata = record.metadata;
  const review = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>)["review"] : undefined;
  const fields = typeof review === "object" && review !== null ? (review as Record<string, unknown>) : {};
  const raw = fields["pane"];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { reason: NOTIFY_NO_PANE };
  if (typeof raw !== "string") return { reason: NOTIFY_INVALID_PANE };
  const pane = raw.trim();
  if (!REVIEW_PANE_PATTERN.test(pane)) return { reason: NOTIFY_INVALID_PANE };
  const socket = fields["socket"];
  if (!isReviewSocketPath(socket) || !isSocketOnDisk(socket)) return { reason: NOTIFY_UNKNOWN_SESSION };
  return { pane, socket };
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

/** herdr's error output as one short line: `message (code)` from its JSON error, else the first non-empty line. */
function herdrFailure(stderr: string, stdout: string): string | null {
  const line = [stderr, stdout]
    .flatMap((text) => text.split("\n"))
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const error = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
  if (typeof error !== "object" || error === null) return line;
  const { message, code } = error as { message?: unknown; code?: unknown };
  const hasCode = typeof code === "string" && code !== "";
  if (typeof message === "string" && message.trim() !== "") return hasCode ? `${message.trim()} (${code})` : message.trim();
  return hasCode ? code : line;
}

export interface HerdrRunnerOptions {
  /** The executable; `herdr` on PATH by default (tests point it at a stub). */
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** The default herdr runner (module header): no shell, SIGTERM then SIGKILL, reasons that never echo the prompt. */
export function createHerdrRunner(options: HerdrRunnerOptions = {}): RunHerdr {
  const command = options.command ?? "herdr";
  const timeoutMs = options.timeoutMs ?? REVIEW_HERDR_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? REVIEW_BD_KILL_GRACE_MS;
  const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} s` : `${(timeoutMs / 1000).toFixed(1)} s`;

  const timedOutReason = `herdr timed out after ${seconds}; the agent may have been notified`;

  return (args, socket) =>
    new Promise<void>((resolve, reject) => {
      // The last argument is the prompt. herdr's output is the only text that
      // could echo it back: the trimmed prompt, and each trimmed line of it
      // long enough not to match by accident, is cut out of that text alone.
      const prompt = args.at(-1) ?? "";
      const echoes = [prompt.trim(), ...prompt.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8)].filter((e) => e !== "");
      const scrub = (said: string) => echoes.reduce((text, echo) => text.split(echo).join("…"), said);
      const fail = (reason: string) => {
        const trimmed = reason.trim();
        reject(new Error(trimmed.length > MAX_NOTIFY_REASON_LENGTH ? `${trimmed.slice(0, MAX_NOTIFY_REASON_LENGTH - 1)}…` : trimmed));
      };
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
      const env = { ...process.env, HERDR_SOCKET_PATH: socket };
      const child = execFile(command, [...args], { env, maxBuffer: BD_MAX_BUFFER, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) {
          finish(() => resolve());
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: string | number; signal?: NodeJS.Signals | null };
        let reason: string;
        if (e.code === "ENOENT") reason = "herdr not found on PATH";
        else if (timedOut) reason = timedOutReason;
        else if (e.signal) reason = `herdr was killed (${e.signal})`;
        else {
          const said = herdrFailure(typeof stderr === "string" ? stderr : "", typeof stdout === "string" ? stdout : "");
          reason = said !== null ? scrub(said) : typeof e.code === "number" ? `herdr exited ${e.code}` : `herdr could not run (${String(e.code ?? "unknown error")})`;
        }
        finish(() => fail(reason));
      });
      const termTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }, timeoutMs);
      const deadline = setTimeout(() => {
        finish(() => {
          child.kill("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          fail(timedOutReason);
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
function parseShownIssue(stdout: string): ShownIssue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const issue = Array.isArray(parsed) ? parsed[0] : parsed;
  return typeof issue === "object" && issue !== null ? (issue as ShownIssue) : null;
}

interface ShownIssue {
  id: unknown;
  status: unknown;
  labels: unknown;
  metadata?: unknown;
}

type WriteOutcome = Omit<ReviewWriteResult, "notified">;

export function createReviewWriter(options: ReviewWriterOptions = {}): ReviewWriter {
  const runBd = options.runBd ?? createBdRunner();
  const runHerdr = options.runHerdr ?? createHerdrRunner();
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

  /** Writes the decision; `record` is the tracker's record when one was read. */
  async function decide(input: ReviewWriteInput): Promise<{ outcome: WriteOutcome; record: ShownIssue | null }> {
    const id = input.externalId;
    let shown;
    try {
      shown = parseShownIssue(await runBd(["show", id, "--json"], input.cwd));
    } catch (err) {
      return { outcome: { ok: false, written: [], attempted: false, error: errorText(err), partial: false }, record: null };
    }
    if (shown === null) {
      return { outcome: { ok: false, written: [], attempted: false, error: `bd show ${id} did not return an issue`, partial: false }, record: null };
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
          const error = fitError(`${err.message}; it may have been written — check the tracker before deciding again`);
          return { outcome: { ok: false, written, attempted: true, uncertain: step, error, partial }, record: shown };
        }
        return { outcome: { ok: false, written, attempted: true, error: errorText(err), partial }, record: shown };
      }
      written.push(step);
    }
    return { outcome: { ok: true, written, attempted: true }, record: shown };
  }

  /** Tells the recipient on the tracker's record once the decision fully landed; never throws (module header). */
  async function notify(input: ReviewWriteInput, outcome: WriteOutcome, record: ShownIssue | null): Promise<ReviewNotified> {
    const target = outcome.ok && record !== null ? recipientOf(record) : { reason: NOTIFY_NOT_WRITTEN };
    let notified: ReviewNotified;
    if ("reason" in target) {
      notified = { ok: false, reason: target.reason };
    } else {
      try {
        await runHerdr(["agent", "prompt", target.pane, notifyText(input.decision, input.externalId, input.message)], target.socket);
        notified = { ok: true, pane: target.pane };
      } catch (err) {
        notified = { ok: false, reason: err instanceof Error && err.message !== "" ? err.message : "herdr failed" };
      }
    }
    if (!notified.ok) console.warn(`[breakdown-web] review ${input.project}/${input.externalId}: agent not notified: ${notified.reason}`);
    return notified;
  }

  return {
    async write(input) {
      const key = `${input.project}\0${input.externalId}`;
      if (inFlight.has(key)) throw new ReviewDecisionInFlightError(input.project, input.externalId);
      inFlight.add(key);
      try {
        const { outcome, record } = await serialize(input.cwd, () => decide(input));
        try {
          input.onWritten?.({ ok: outcome.ok, attempted: outcome.attempted });
        } catch (err) {
          console.error(`[breakdown-web] review ${input.project}/${input.externalId}: onWritten failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { ...outcome, notified: await notify(input, outcome, record) };
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
