// Follows one laptop-relay action (laptop-relay design.md decision 8): reads
// `relayAction(id)` at once, then every RELAY_ACTION_POLL_MS while it is
// queued or claimed, and stops once it is done or failed. A hidden tab makes
// no requests; it reads again the moment the tab is visible. A failed read
// keeps the last answer and is retried on the next tick: the board's own
// reads already surface a lost connection. `id` null follows nothing.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { isRelayActionOpen, type RelayActionView } from "./relayAction.js";

export const RELAY_ACTION_POLL_MS = 2_000;

/** The latest answer for `id`, or null before the first one (and for `id` null). */
export function useRelayAction(id: number | null): RelayActionView | null {
  const [latest, setLatest] = useState<RelayActionView | null>(null);

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    let inFlight = false;
    let finished = false;

    async function poll(): Promise<void> {
      if (cancelled || finished || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const action = await trpc.relayAction.query({ id: id! });
        if (cancelled) return;
        setLatest(action);
        if (!isRelayActionOpen(action.state)) {
          finished = true;
          stop();
        }
      } catch {
        // Retried on the next tick (module header).
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = (): void => void poll();
    const timer = setInterval(() => void poll(), RELAY_ACTION_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    function stop(): void {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    }
    void poll();
    return () => {
      cancelled = true;
      stop();
    };
  }, [id]);

  return latest !== null && latest.id === id ? latest : null;
}
