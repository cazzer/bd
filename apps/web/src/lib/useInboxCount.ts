// The shell header's inbox count (shared-nav-header, design.md decision 6):
// how many inbox items Needs me lists, read by the header, never by a view,
// so a read re-renders the header and not the memoized view under it.
//
// It reads the pending items (`trpc.inbox` with `statuses: ["pending"]`) on
// InboxView's own cadence (`INBOX_POLL_MS`) and counts them with InboxView's
// own predicate (lib/inboxRows.ts `needsMeItemCount`), so the two never
// disagree and no review is counted here: the review control counts those
// from the queue. The poll stops while the tab is hidden and, when it shows
// again, reads at once and resumes. The count is null until the first read
// lands and after a failed read: the control then shows no inbox count and
// works as before. A read that resolves after a newer one started, or after
// unmount, is dropped.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { INBOX_POLL_MS, needsMeItemCount } from "./inboxRows.js";

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

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return count;
}
