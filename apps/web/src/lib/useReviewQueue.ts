// The review queue as React state: the hook over lib/reviewQueueReader.ts
// (whose header says what it reads and when), registered on the tab's one
// live stream for as long as the component is mounted.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { subscribeLive } from "./liveStream.js";
import { createReviewQueueReader, INITIAL_REVIEW_QUEUE, type ReviewQueueState } from "./reviewQueueReader.js";

export type { ReviewQueueState } from "./reviewQueueReader.js";

export function useReviewQueue(): ReviewQueueState {
  const [state, setState] = useState<ReviewQueueState>(INITIAL_REVIEW_QUEUE);

  useEffect(() => {
    const reader = createReviewQueueReader({ query: () => trpc.reviewQueue.query(), subscribe: subscribeLive, onChange: setState });
    return () => reader.dispose();
  }, []);

  return state;
}
