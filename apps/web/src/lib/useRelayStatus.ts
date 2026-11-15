// The latest `relayStatus` (laptop-relay design.md decision 8), read on
// mount, every RELAY_STATUS_POLL_MS while the tab is visible, and at once
// when it becomes visible again, as the hangar pill reads its own. A failed
// read answers null until one succeeds. The board's relay pill words it;
// the inbox reads `missingBinaries` from it to say a pane will be told when
// the relay runs.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import type { RelayStatusView } from "./relayStatus.js";

export const RELAY_STATUS_POLL_MS = 30_000;

export interface PolledRelayStatus {
  status: RelayStatusView;
  /** When the answer arrived, in the browser's clock: what the label is worded against. */
  at: Date;
}

export function useRelayStatus(): PolledRelayStatus | null {
  const [polled, setPolled] = useState<PolledRelayStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function poll(): Promise<void> {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const status = await trpc.relayStatus.query();
        if (!cancelled) setPolled({ status, at: new Date() });
      } catch {
        if (!cancelled) setPolled(null);
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = (): void => void poll();
    void poll();
    const timer = setInterval(() => void poll(), RELAY_STATUS_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return polled;
}
