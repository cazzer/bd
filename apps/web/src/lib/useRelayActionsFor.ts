// The laptop-relay actions of the items on screen (laptop-relay design.md
// decision 8; server `relayActionsFor`): per item, its open action, else the
// one that finished in the last 24 h. Read at once, again whenever the ids
// change or `refresh` is bumped (the host's own re-read, a decision), and
// every RELAY_ACTION_POLL_MS while any answer is still open and the tab is
// visible, so a pending notice turns into the relay's answer as promptly as
// a single action's poll would. A failed read keeps the last answer and is
// retried on the next tick or refresh; the last answer is also kept while
// the ids change and the next read is out. An answer that says what the
// last one said keeps the last map, so a host deriving notices from it does
// not re-render every tick. No ids reads nothing.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { isRelayActionOpen, sameRelayAction, type RelayOriginActionView } from "./relayAction.js";
import { RELAY_ACTION_POLL_MS } from "./useRelayAction.js";

/** At most this many ids per read (server `MAX_RELAY_ORIGIN_IDS`); the host passes the ones that matter most first. */
export const MAX_RELAY_ORIGIN_IDS = 200;

const EMPTY: ReadonlyMap<string, RelayOriginActionView> = new Map();

function sameMap(a: ReadonlyMap<string, RelayOriginActionView>, b: ReadonlyMap<string, RelayOriginActionView>): boolean {
  if (a.size !== b.size) return false;
  for (const [origin, action] of b) {
    const before = a.get(origin);
    if (before === undefined || !sameRelayAction(before, action) || before.kind !== action.kind) return false;
  }
  return true;
}

/** The latest answer, keyed by origin node id; empty before the first one. */
export function useRelayActionsFor(originNodeIds: readonly string[], refresh: number): ReadonlyMap<string, RelayOriginActionView> {
  const [latest, setLatest] = useState<ReadonlyMap<string, RelayOriginActionView>>(EMPTY);
  const ids = [...new Set(originNodeIds)].slice(0, MAX_RELAY_ORIGIN_IDS);
  const key = ids.join(",");

  useEffect(() => {
    if (key === "") return;
    const asked = key.split(",");
    let cancelled = false;
    let inFlight = false;
    let anyOpen = false;

    async function read(): Promise<void> {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const { actions } = await trpc.relayActionsFor.query({ originNodeIds: asked });
        if (cancelled) return;
        const next = new Map(actions.map((a) => [a.originNodeId, a]));
        anyOpen = actions.some((a) => isRelayActionOpen(a.state));
        setLatest((prev) => (sameMap(prev, next) ? prev : next));
      } catch {
        // Retried on the next tick or refresh (module header).
      } finally {
        inFlight = false;
      }
    }

    const tick = (): void => {
      if (anyOpen && !document.hidden) void read();
    };
    const onVisibility = (): void => {
      if (!document.hidden) void read();
    };
    const timer = setInterval(tick, RELAY_ACTION_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void read();
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, refresh]);

  return key === "" ? EMPTY : latest;
}
