// Tests for lib/reviewRun.ts (review-queue, tasks.md 6.2): the snapshot
// order, passing over reviews decided elsewhere, arrivals joining the end,
// skip, tallies, the done state, and the spec's three scenarios at the
// model level.

import { describe, expect, it } from "vitest";
import { answerRun, currentPending, currentReview, finishRun, leftPending, runLog, runProgress, runTallies, startRun, syncRun, type ReviewRun, type RunItem } from "./reviewRun.js";

const r = (id: string): RunItem => ({ id });
const ids = (items: readonly RunItem[]) => items.map((i) => i.id);
const shown = (run: ReviewRun<RunItem>) => currentReview(run)?.id ?? null;
const without = (live: readonly RunItem[], ...gone: string[]) => live.filter((i) => !gone.includes(i.id));

const A = r("a");
const B = r("b");
const C = r("c");
const D = r("d");

describe("startRun", () => {
  it("snapshots the queue's order and shows the first review", () => {
    const live = [A, B, C];
    const run = startRun(live);
    expect(ids(run.items)).toEqual(["a", "b", "c"]);
    expect(shown(run)).toBe("a");
    expect(run.done).toBe(false);
    expect(runProgress(run, live)).toEqual({ position: 1, total: 3 });
  });

  it("copies the snapshot, so a later change to the queue array is not the run's order", () => {
    const live = [A, B];
    const run = startRun(live);
    live.reverse();
    expect(ids(run.items)).toEqual(["a", "b"]);
  });

  it("is done at once over an empty queue, with nothing on screen and zero tallies", () => {
    const run = startRun<RunItem>([]);
    expect(run.done).toBe(true);
    expect(currentReview(run)).toBeNull();
    expect(runProgress(run, [])).toEqual({ position: 0, total: 0 });
    expect(runTallies(run)).toEqual({ accepted: 0, changes: 0, skipped: 0 });
  });
});

describe("answerRun", () => {
  it("records the answer and moves to the next review in snapshot order", () => {
    const live = [A, B, C];
    const run = answerRun(startRun(live), live, "a", "accepted");
    expect(shown(run)).toBe("b");
    expect(run.results.get("a")).toBe("accepted");
  });

  it("does not revisit a review answered here while the queue still lists it (its read has not landed)", () => {
    const live = [A, B];
    let run = answerRun(startRun(live), live, "a", "changes");
    run = syncRun(run, live);
    expect(ids(run.items)).toEqual(["a", "b"]);
    run = answerRun(run, live, "b", "skipped");
    expect(run.done).toBe(true);
  });

  it("passes over a review that left the live queue, without a tally", () => {
    const live = [A, B, C];
    const run = answerRun(startRun(live), without(live, "b"), "a", "accepted");
    expect(shown(run)).toBe("c");
    expect(runTallies(run)).toEqual({ accepted: 1, changes: 0, skipped: 0 });
  });

  it("finishes when nothing pending is left after the current review", () => {
    const live = [A, B];
    const run = answerRun(startRun(live), without(live, "a", "b"), "a", "accepted");
    expect(run.done).toBe(true);
    expect(currentReview(run)).toBeNull();
  });

  it("takes `null` for a review that stopped being pending: moves on, tallies nothing", () => {
    const live = [A, B];
    const run = answerRun(startRun(live), without(live, "a"), "a", null);
    expect(shown(run)).toBe("b");
    expect(run.results.size).toBe(0);
  });

  it("ignores an answer for a review that is not the one on screen", () => {
    const live = [A, B, C];
    const run = answerRun(startRun(live), live, "a", "accepted");
    expect(answerRun(run, live, "a", "accepted")).toBe(run);
    expect(answerRun(run, live, "c", "skipped")).toBe(run);
  });

  it("changes nothing once done", () => {
    const live = [A];
    const done = answerRun(startRun(live), live, "a", "skipped");
    expect(done.done).toBe(true);
    expect(answerRun(done, live, "a", "accepted")).toBe(done);
  });

  it("considers reviews that arrived with this answer's live queue", () => {
    const run = answerRun(startRun([A]), [A, D], "a", "accepted");
    expect(shown(run)).toBe("d");
    expect(ids(run.items)).toEqual(["a", "d"]);
  });

  it("does not mutate the run it was given", () => {
    const live = [A, B];
    const before = startRun(live);
    answerRun(before, live, "a", "accepted");
    expect(before.current).toBe(0);
    expect(before.results.size).toBe(0);
  });
});

describe("syncRun", () => {
  it("appends reviews new to the run at the end, in the queue's order", () => {
    const run = syncRun(startRun([A, B]), [D, A, C, B]);
    expect(ids(run.items)).toEqual(["a", "b", "d", "c"]);
    expect(shown(run)).toBe("a");
  });

  it("returns the same run when nothing is new", () => {
    const run = startRun([A, B]);
    expect(syncRun(run, [B])).toBe(run);
    expect(syncRun(run, [])).toBe(run);
  });

  it("never adds an id twice, even one that left the queue and came back", () => {
    const live = [A, B];
    let run = answerRun(startRun(live), without(live, "b"), "a", "accepted");
    run = syncRun(run, [B]);
    expect(ids(run.items)).toEqual(["a", "b"]);
  });

  it("leaves a done run done: the summary does not turn back into a review", () => {
    const done = answerRun(startRun([A]), [A], "a", "accepted");
    expect(syncRun(done, [A, D])).toBe(done);
  });
});

describe("runProgress", () => {
  it("counts answered, the one on screen, and the pending ones ahead", () => {
    const live = [A, B, C];
    let run = startRun(live);
    run = answerRun(run, live, "a", "accepted");
    expect(runProgress(run, live)).toEqual({ position: 2, total: 3 });
    run = answerRun(run, live, "b", "skipped");
    expect(runProgress(run, live)).toEqual({ position: 3, total: 3 });
  });

  it("drops a review ahead from the total as soon as it leaves the live queue", () => {
    const live = [A, B, C];
    const run = startRun(live);
    expect(runProgress(run, without(live, "b"))).toEqual({ position: 1, total: 2 });
  });

  it("grows with arrivals", () => {
    const run = syncRun(startRun([A]), [A, D]);
    expect(runProgress(run, [A, D])).toEqual({ position: 1, total: 2 });
  });

  it("reads answered of answered once done (a passed-over review is not counted)", () => {
    const live = [A, B, C];
    let run = answerRun(startRun(live), without(live, "b"), "a", "accepted");
    run = answerRun(run, without(live, "b"), "c", "skipped");
    expect(run.done).toBe(true);
    expect(runProgress(run, without(live, "b"))).toEqual({ position: 2, total: 2 });
  });
});

describe("currentPending", () => {
  it("says whether the review on screen is still in the live queue", () => {
    const live = [A, B];
    const run = startRun(live);
    expect(currentPending(run, live)).toBe(true);
    expect(currentPending(run, [B])).toBe(false);
    expect(currentPending(answerRun(run, [A], "a", "skipped"), [A])).toBe(false);
  });
});

describe("leftPending", () => {
  it("lists the skipped reviews still pending, in run order", () => {
    const live = [A, B, C, D];
    let run = startRun(live);
    run = answerRun(run, live, "a", "skipped");
    run = answerRun(run, live, "b", "accepted");
    run = answerRun(run, live, "c", "skipped");
    run = answerRun(run, live, "d", "skipped");
    expect(ids(leftPending(run, live))).toEqual(["a", "c", "d"]);
    expect(ids(leftPending(run, without(live, "c")))).toEqual(["a", "d"]);
  });

  it("starts a new run over them", () => {
    const live = [A, B];
    let run = startRun(live);
    run = answerRun(run, live, "a", "skipped");
    run = answerRun(run, live, "b", "skipped");
    const again = startRun(leftPending(run, live));
    expect(ids(again.items)).toEqual(["a", "b"]);
    expect(runTallies(again)).toEqual({ accepted: 0, changes: 0, skipped: 0 });
  });
});

describe("spec scenarios (review-queue, 'The queue can be reviewed in sequence')", () => {
  it("working through the queue: accept, skip, request changes → one of each, done", () => {
    let live = [A, B, C];
    let run = startRun(live);
    expect(runProgress(run, live)).toEqual({ position: 1, total: 3 });

    run = answerRun(run, live, "a", "accepted");
    live = without(live, "a"); // the accepted review leaves the queue on the next read
    run = syncRun(run, live);
    expect(shown(run)).toBe("b");
    expect(runProgress(run, live)).toEqual({ position: 2, total: 3 });

    run = answerRun(run, live, "b", "skipped");
    expect(shown(run)).toBe("c");
    expect(runProgress(run, live)).toEqual({ position: 3, total: 3 });

    run = answerRun(run, live, "c", "changes");
    live = without(live, "c"); // a sent-back review is no longer pending
    run = syncRun(run, live);
    expect(run.done).toBe(true);
    expect(runTallies(run)).toEqual({ accepted: 1, changes: 1, skipped: 1 });
    expect(ids(leftPending(run, live))).toEqual(["b"]);
  });

  it("decided elsewhere meanwhile: the next review is passed over and the one after it shown", () => {
    let live = [A, B, C];
    let run = startRun(live);
    live = without(live, "b"); // accepted from another tab
    run = syncRun(run, live);
    run = answerRun(run, live, "a", "accepted");
    expect(shown(run)).toBe("c");
    expect(runProgress(run, live)).toEqual({ position: 2, total: 2 });
  });

  // "Write fails" is the panel's guarantee, not the run's: the host hears a
  // decision only when it reports ok (lib/reviewDrawer.ts decisionEffects,
  // tested in reviewDrawer.test.ts), and only then calls answerRun.
});

describe("finishRun", () => {
  it("stops the run early: done, answers kept, the unreached pending ones left for later", () => {
    const live = [A, B, C];
    let run = answerRun(startRun(live), live, "a", "accepted");
    run = finishRun(run);
    expect(run.done).toBe(true);
    expect(currentReview(run)).toBeNull();
    expect(runTallies(run)).toEqual({ accepted: 1, changes: 0, skipped: 0 });
    expect(ids(leftPending(run, live))).toEqual(["b", "c"]);
    expect(finishRun(run)).toBe(run);
  });
});

describe("runLog", () => {
  it("says what became of each review: its answer, left for later, or gone from the queue unanswered", () => {
    const live = [A, B, C, D];
    let run = answerRun(startRun(live), live, "a", "changes");
    run = answerRun(run, without(live, "c"), "b", "skipped");
    run = finishRun(run);
    expect(runLog(run, without(live, "c")).map((e) => [e.item.id, e.result])).toEqual([
      ["a", "changes"],
      ["b", "skipped"],
      ["c", "elsewhere"],
      ["d", "left"],
    ]);
  });
});
