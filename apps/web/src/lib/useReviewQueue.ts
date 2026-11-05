// The pending review queue, kept current (review-queue, design.md decision
// 2): the second listener on the tab's one live stream (lib/liveStream.ts).
// It reads `reviewQueue` whenever the stream (re)starts and on every
// `changed` event — any event, because a new review is an id the queue has
// never seen — debounced and never overlapping exactly as the board's reads
// are (lib/readScheduler.ts). `version` counts successful reads, so a drawer
// opened from the queue re-reads after each, as the board's does after each
// board read. A failed stream leaves the queue with its one read; the
// failure itself shows through `useLiveState()`, not `error`, which is the
// last read's failure (cleared by the next success).

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { subscribeLive } from "./liveStream.js";
import { createReadScheduler } from "./readScheduler.js";

const READ_DEBOUNCE_MS = 150;
const READ_MAX_WAIT_MS = 1000;

type ReviewQueueAnswer = Awaited<ReturnType<typeof trpc.reviewQueue.query>>;

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

const INITIAL: ReviewQueueState = { reviews: [], total: 0, truncated: false, version: 0, error: null, loaded: false };

export function useReviewQueue(): ReviewQueueState {
  const [state, setState] = useState<ReviewQueueState>(INITIAL);

  useEffect(() => {
    let disposed = false;
    const scheduler = createReadScheduler({
      debounceMs: READ_DEBOUNCE_MS,
      maxWaitMs: READ_MAX_WAIT_MS,
      read: async () => {
        try {
          const answer = await trpc.reviewQueue.query();
          if (disposed) return;
          setState((s) => ({ reviews: answer.reviews, total: answer.total, truncated: answer.truncated, version: s.version + 1, error: null, loaded: true }));
        } catch (err) {
          if (disposed) return;
          const message = err instanceof Error ? err.message : "Failed to read the review queue.";
          setState((s) => ({ ...s, error: message }));
        }
      },
    });
    const unsubscribe = subscribeLive({
      onStarted: () => scheduler.run(),
      onEvent: (event) => {
        if (event.kind === "changed") scheduler.schedule();
      },
      onError: () => scheduler.run(),
    });
    return () => {
      disposed = true;
      scheduler.dispose();
      unsubscribe();
    };
  }, []);

  return state;
}
