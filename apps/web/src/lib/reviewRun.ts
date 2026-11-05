// The review-all run (review-queue, design.md decision 6), as plain data:
// what ReviewRunModal shows and where it goes next. Pure, so the order
// rules are tested without React.
//
// A run takes the queue's order when it opens (the snapshot) and shows one
// review at a time. Answering the current review — accepted, sent back,
// skipped, or `null` for one that stopped being pending before it was
// answered — moves to the next review in run order that is still pending
// in the live queue and not yet answered, so one decided elsewhere
// meanwhile is passed over without a tally. Reviews that join the live
// queue while the run is open join the end of the run, in the queue's
// order; an id the run has already held is never added twice, which is
// what keeps a review decided here from rejoining before the next queue
// read drops it. A run with nothing left to show is done, and done is
// final: the summary does not turn back into a review when one arrives.
//
// The position line counts what the person has reached (answered and
// current) and what is still ahead and pending, so a review decided
// elsewhere drops out of "n of m" as soon as the live queue says so.

export type RunResult = "accepted" | "changes" | "skipped";

export interface RunItem {
  id: string;
}

export interface ReviewRun<T extends RunItem> {
  /** Run order: the snapshot, then arrivals. */
  readonly items: readonly T[];
  readonly results: ReadonlyMap<string, RunResult>;
  /** Index of the review on screen; meaningless once `done`. */
  readonly current: number;
  readonly done: boolean;
}

export interface RunTallies {
  accepted: number;
  changes: number;
  skipped: number;
}

export function startRun<T extends RunItem>(reviews: readonly T[]): ReviewRun<T> {
  return { items: [...reviews], results: new Map(), current: 0, done: reviews.length === 0 };
}

/** The review on screen, or null once the run is done. */
export function currentReview<T extends RunItem>(run: ReviewRun<T>): T | null {
  return run.done ? null : (run.items[run.current] ?? null);
}

/** Append live reviews the run has never held; the same run object when there are none, or once done. */
export function syncRun<T extends RunItem>(run: ReviewRun<T>, live: readonly T[]): ReviewRun<T> {
  if (run.done) return run;
  const held = new Set(run.items.map((r) => r.id));
  const arrivals = live.filter((r) => !held.has(r.id));
  if (arrivals.length === 0) return run;
  return { ...run, items: [...run.items, ...arrivals] };
}

/**
 * Record `result` for the review on screen (none for `null`) and move to the
 * next pending, unanswered review, or finish. `id` names the review the
 * answer is for: an answer for any other review (a late callback after the
 * run already moved) changes nothing.
 */
export function answerRun<T extends RunItem>(run: ReviewRun<T>, live: readonly T[], id: string, result: RunResult | null): ReviewRun<T> {
  const shown = currentReview(run);
  if (shown === null || shown.id !== id) return run;
  const synced = syncRun(run, live);
  const results = new Map(synced.results);
  if (result !== null) results.set(id, result);
  const pending = new Set(live.map((r) => r.id));
  const next = synced.items.findIndex((r, i) => i > synced.current && pending.has(r.id) && !results.has(r.id));
  return next === -1 ? { ...synced, results, done: true } : { ...synced, results, current: next };
}

/** Whether the review on screen is still in the live queue (false once done). */
export function currentPending<T extends RunItem>(run: ReviewRun<T>, live: readonly T[]): boolean {
  const shown = currentReview(run);
  return shown !== null && live.some((r) => r.id === shown.id);
}

/** "n of m": reviews reached (answered and the one on screen) of those plus the pending ones still ahead. */
export function runProgress<T extends RunItem>(run: ReviewRun<T>, live: readonly T[]): { position: number; total: number } {
  const answered = run.results.size;
  if (run.done) return { position: answered, total: answered };
  const pending = new Set(live.map((r) => r.id));
  const ahead = run.items.filter((r, i) => i > run.current && pending.has(r.id) && !run.results.has(r.id)).length;
  const position = answered + 1;
  return { position, total: position + ahead };
}

export function runTallies<T extends RunItem>(run: ReviewRun<T>): RunTallies {
  const tallies: RunTallies = { accepted: 0, changes: 0, skipped: 0 };
  for (const result of run.results.values()) {
    if (result === "accepted") tallies.accepted += 1;
    else if (result === "changes") tallies.changes += 1;
    else tallies.skipped += 1;
  }
  return tallies;
}

/** The skipped reviews still pending, in run order: what "Review skipped" starts a new run over. */
export function skippedPending<T extends RunItem>(run: ReviewRun<T>, live: readonly T[]): T[] {
  const pending = new Set(live.map((r) => r.id));
  return run.items.filter((r) => run.results.get(r.id) === "skipped" && pending.has(r.id));
}
