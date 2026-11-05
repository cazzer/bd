// The read discipline every live reader shares (live-beads-board design.md
// decision 7, review-queue design.md decision 2): the board and the review
// queue each re-read their whole answer when the live stream says something
// changed, and both must neither hammer the server during a burst nor fall
// behind during a sustained one.
//
// `schedule()` debounces: a read goes out `debounceMs` after the latest
// request, but a continuous stream of requests cannot defer it past
// `maxWaitMs` from the first. `run()` reads now (a stream (re)start, a chip
// toggle, a manual refresh) and cancels any debounced read pending, which
// the read it starts covers. Reads never overlap and never supersede one
// another: a read requested while one runs marks it dirty, and exactly one
// follow-up runs when it finishes, so sustained writes cannot starve the
// reader. `dispose()` cancels the timer and stops any follow-up; a read
// already in flight finishes, and its caller guards its own state writes.

/** The live readers' debounce: a burst of events collapses to one read this long after the last. */
export const READ_DEBOUNCE_MS = 150;
/** A continuous stream of events cannot defer a live reader's read longer than this. */
export const READ_MAX_WAIT_MS = 1000;

export interface ReadSchedulerOptions {
  /** One read of the whole answer; must not reject (it reports its own failure). */
  read: () => Promise<void>;
  debounceMs: number;
  maxWaitMs: number;
  /** Called with true when a read loop starts and false when it ends. */
  onBusyChange?: (busy: boolean) => void;
  now?: () => number;
}

export interface ReadScheduler {
  schedule(): void;
  run(): void;
  dispose(): void;
}

export function createReadScheduler(options: ReadSchedulerOptions): ReadScheduler {
  const { read, debounceMs, maxWaitMs, onBusyChange } = options;
  const now = options.now ?? Date.now;
  let disposed = false;
  let inFlight = false;
  let dirty = false;
  let firstWake: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancelPending() {
    clearTimeout(timer);
    timer = undefined;
    firstWake = null;
  }

  async function loop() {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    onBusyChange?.(true);
    try {
      do {
        dirty = false;
        await read();
      } while (dirty && !disposed);
    } finally {
      inFlight = false;
      if (!disposed) onBusyChange?.(false);
    }
  }

  return {
    schedule() {
      if (disposed) return;
      const t = now();
      firstWake ??= t;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = undefined;
          firstWake = null;
          void loop();
        },
        Math.min(debounceMs, Math.max(0, firstWake + maxWaitMs - t)),
      );
    },
    run() {
      if (disposed) return;
      cancelPending();
      void loop();
    },
    dispose() {
      disposed = true;
      cancelPending();
    },
  };
}
