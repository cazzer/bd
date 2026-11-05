import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent, LiveListener } from "./liveStream.js";
import { READ_DEBOUNCE_MS } from "./readScheduler.js";
import { createReviewQueueReader, type ReviewQueueAnswer, type ReviewQueueState } from "./reviewQueueReader.js";

type Row = ReviewQueueAnswer["reviews"][number];
/** The reader never looks inside a row, so an id is all a fixture row needs. */
const row = (id: string) => ({ externalId: id }) as unknown as Row;
const answer = (...ids: string[]): ReviewQueueAnswer => ({ reviews: ids.map(row), total: ids.length, truncated: false });

const CHANGED: LiveEvent = { kind: "changed", project: "p", changedNodeIds: ["n1"], at: "2026-11-05T00:00:00.000Z" };
const LOAD_ERROR: LiveEvent = { kind: "error", project: "p", message: "load failed", at: "2026-11-05T00:00:00.000Z" };

function setup(results: (ReviewQueueAnswer | Error)[]) {
  const box: { live?: LiveListener } = {};
  const unsubscribe = vi.fn();
  const states: ReviewQueueState[] = [];
  const query = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("no more fixture answers");
    if (next instanceof Error) throw next;
    return next;
  });
  const reader = createReviewQueueReader({
    query,
    subscribe: (l) => {
      box.live = l;
      return unsubscribe;
    },
    onChange: (s) => states.push(s),
  });
  const listener = () => {
    if (box.live === undefined) throw new Error("the reader did not subscribe");
    return box.live;
  };
  return { reader, query, states, unsubscribe, listener };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createReviewQueueReader", () => {
  it("reads on onStarted and bumps version on success", async () => {
    const t = setup([answer("r1", "r2")]);
    expect(t.query).not.toHaveBeenCalled();
    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.query).toHaveBeenCalledTimes(1);
    expect(t.reader.getState()).toMatchObject({ total: 2, truncated: false, version: 1, error: null, loaded: true });
    expect(t.states).toHaveLength(1);
  });

  it("reads once on a stream failure", async () => {
    const t = setup([answer("r1")]);
    t.listener().onError?.(new Error("no watcher"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.query).toHaveBeenCalledTimes(1);
    expect(t.reader.getState()).toMatchObject({ total: 1, version: 1, error: null, loaded: true });
  });

  it("schedules a debounced read on a changed event, and none on an error event", async () => {
    const t = setup([answer("r1"), answer("r1", "r2")]);
    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);

    t.listener().onEvent(LOAD_ERROR);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS * 10);
    expect(t.query).toHaveBeenCalledTimes(1);

    t.listener().onEvent(CHANGED);
    t.listener().onEvent(CHANGED);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS - 1);
    expect(t.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.query).toHaveBeenCalledTimes(2);
    expect(t.reader.getState()).toMatchObject({ total: 2, version: 2 });
  });

  it("keeps the last answer and its version when a read fails, and clears the error on the next success", async () => {
    const t = setup([answer("r1"), new Error("database down"), answer("r1", "r2", "r3")]);
    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);
    const first = t.reader.getState();

    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reader.getState()).toEqual({ ...first, error: "database down" });

    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reader.getState()).toMatchObject({ total: 3, version: 2, error: null, loaded: true });
  });

  it("is not loaded until a read succeeds", async () => {
    const t = setup([new Error("database down")]);
    t.listener().onStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.reader.getState()).toMatchObject({ loaded: false, version: 0, error: "database down" });
  });

  it("unsubscribes on dispose and drops a read that lands after it", async () => {
    let resolve: (a: ReviewQueueAnswer) => void = () => {};
    const states: ReviewQueueState[] = [];
    const box: { live?: LiveListener } = {};
    const unsubscribe = vi.fn();
    const reader = createReviewQueueReader({
      query: () => new Promise((r) => (resolve = r)),
      subscribe: (l) => {
        box.live = l;
        return unsubscribe;
      },
      onChange: (s) => states.push(s),
    });
    box.live?.onStarted();
    expect(box.live).toBeDefined();
    reader.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    resolve(answer("r1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(0);
  });
});
