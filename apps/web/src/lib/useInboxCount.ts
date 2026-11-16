// The shell header's inbox count (shared-nav-header, design.md decision 6):
// how many inbox items Needs me lists, read by the header, never by a view,
// so a read re-renders the header and not the memoized view under it.
//
// It reads the pending items (`trpc.inbox` with `statuses: ["pending"]`) on
// InboxView's own cadence (`INBOX_POLL_MS`) and counts them with InboxView's
// own predicate (lib/inboxRows.ts `needsMeItemCount`), so both count by one
// rule, and no review is counted here: the review control counts those from
// the queue. They can still differ for a moment (each polls on its own) or
// when InboxView's all-status read reaches its 500-item cap, which this
// pending-only read does not. The poll stops while the tab is hidden and,
// when it shows again, reads at once and resumes. `inboxChanged()` asks
// every mounted count to read now — the inbox calls it after a decision, so
// the header follows without waiting for the next poll. The count is null
// until the first read lands and after a failed read: the control then
// shows no inbox count and works as before. A read that resolves after a
// newer one started, or after unmount, is dropped.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { INBOX_POLL_MS, needsMeItemCount } from "./inboxRows.js";

const readers = new Set<() => void>();

/** The inbox changed here (a decision, a release, a hand-off): every mounted inbox count reads now. */
export function inboxChanged(): void {
  for (const read of readers) read();
}

export function useInboxCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: number | undefined;

    async function read() {
      const mine = ++generation;
      try {
        const result = await trpc.inbox.query({ statuses: ["pending"] });
        if (!disposed && mine === generation) setCount(needsMeItemCount(result.items));
      } catch {
        if (!disposed && mine === generation) setCount(null);
      }
    }

    function start() {
      if (timer !== undefined) return;
      void read();
      timer = window.setInterval(() => void read(), INBOX_POLL_MS);
    }

    function stop() {
      window.clearInterval(timer);
      timer = undefined;
    }

    function onVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    const readNow = () => void read();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    readers.add(readNow);
    return () => {
      disposed = true;
      stop();
      readers.delete(readNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return count;
}
