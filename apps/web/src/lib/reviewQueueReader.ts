// The pending review queue, kept current (review-queue, design.md decision
// 2): the second listener on the tab's one live stream (lib/liveStream.ts).
// It reads the queue whenever the stream (re)starts and on every `changed`
// event — any event, because a new review is an id the queue has never seen
// — debounced and never overlapping exactly as the board's reads are
// (lib/readScheduler.ts); an `error` event is one project's load failing and
// changes nothing the queue shows. `version` counts successful reads, so a
// drawer opened from the queue re-reads after each, as the board's does
// after each board read. A failed read keeps the last answer and sets
// `error`, which the next success clears. A failed stream leaves the queue
// with its one read; the failure itself shows through `useLiveState()`, not
// `error`.
//
// Plain code over an injected query and live subscribe, so it is testable
// without React or a tRPC client; useReviewQueue.ts is the hook over it.

import type { trpc } from "../trpc.js";
import type { LiveListener } from "./liveStream.js";
import { createReadScheduler, READ_DEBOUNCE_MS, READ_MAX_WAIT_MS } from "./readScheduler.js";

export type ReviewQueueAnswer = Awaited<ReturnType<typeof trpc.reviewQueue.query>>;

export interface ReviewQueueState {
  reviews: ReviewQueueAnswer["reviews"];
  total: number;
  truncated: boolean;
  /** Bumped after each successful read. */
  version: number;
  error: string | null;
  /** Whether any read has succeeded yet. */
  loaded: boolean;
}

export const INITIAL_REVIEW_QUEUE: ReviewQueueState = { reviews: [], total: 0, truncated: false, version: 0, error: null, loaded: false };

export interface ReviewQueueReaderDeps {
  query: () => Promise<ReviewQueueAnswer>;
  subscribe: (listener: LiveListener) => () => void;
  /** Called with each new state. */
  onChange: (state: ReviewQueueState) => void;
}

export interface ReviewQueueReader {
  getState(): ReviewQueueState;
  dispose(): void;
}

export function createReviewQueueReader(deps: ReviewQueueReaderDeps): ReviewQueueReader {
  let state = INITIAL_REVIEW_QUEUE;
  let disposed = false;

  function update(next: ReviewQueueState) {
    state = next;
    deps.onChange(state);
  }

  const scheduler = createReadScheduler({
    debounceMs: READ_DEBOUNCE_MS,
    maxWaitMs: READ_MAX_WAIT_MS,
    read: async () => {
      try {
        const answer = await deps.query();
        if (disposed) return;
        update({ reviews: answer.reviews, total: answer.total, truncated: answer.truncated, version: state.version + 1, error: null, loaded: true });
      } catch (err) {
        if (disposed) return;
        update({ ...state, error: err instanceof Error ? err.message : "Failed to read the review queue." });
      }
    },
  });

  const unsubscribe = deps.subscribe({
    onStarted: () => scheduler.run(),
    onEvent: (event) => {
      if (event.kind === "changed") scheduler.schedule();
    },
    onError: () => scheduler.run(),
  });

  return {
    getState: () => state,
    dispose() {
      disposed = true;
      scheduler.dispose();
      unsubscribe();
    },
  };
}
