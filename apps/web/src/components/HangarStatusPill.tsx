// The board header's hangar chip (hangar-queue design decision 7): "hangar
// online", "hangar offline since …", or "hangar never checked in", with the
// hangar's name, version, last check-in, and open session counts in its
// tooltip. A status chip, not a control: it takes no focus and has no
// action, so it needs no phone-sized hit target.
//
// It reads `hangarStatus` on mount, every POLL_MS while the tab is visible,
// and at once when the tab becomes visible again; a hidden tab makes no
// requests. Each answer also moves the clock the label is worded against,
// so "since 09:00" gains its date once the day turns. If a read fails the
// chip disappears until one succeeds: hangar's status is a side note on the
// board, and the board's own reads already surface a lost connection.

import { useEffect, useState } from "react";
import { hangarPillLabel, hangarPillTitle, type HangarStatusView } from "../lib/hangarStatus.js";
import { trpc } from "../trpc.js";

export const HANGAR_POLL_MS = 30_000;

interface Polled {
  status: HangarStatusView;
  /** When the answer arrived, in the browser's clock: what the label is worded against. */
  at: Date;
}

/** The latest `hangarStatus`, or null before the first answer and after a failed read. */
function useHangarStatus(): Polled | null {
  const [polled, setPolled] = useState<Polled | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function poll(): Promise<void> {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const status = await trpc.hangarStatus.query();
        if (!cancelled) setPolled({ status, at: new Date() });
      } catch {
        if (!cancelled) setPolled(null);
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = (): void => void poll();
    void poll();
    const timer = setInterval(() => void poll(), HANGAR_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return polled;
}

/** Filled = online, ring = offline, dashed ring = never: the shape carries the state, not only the colour. */
function HangarLight({ status }: { status: HangarStatusView["status"] }) {
  const cls =
    status === "online"
      ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]"
      : status === "offline"
        ? "border-[1.5px] border-red-400"
        : "border-[1.5px] border-dashed border-fg-muted";
  return <span aria-hidden="true" data-hangar={status} className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

export function HangarStatusPill() {
  const polled = useHangarStatus();
  if (polled === null) return null;
  const { status, at } = polled;

  return (
    <span
      role="status"
      title={hangarPillTitle(status, at)}
      data-hangar-pill={status.status}
      className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-hairline px-3 text-xs whitespace-nowrap text-fg-muted"
    >
      <HangarLight status={status.status} />
      {/* The dot alone on phones, where the header is tight; the words stay readable to a screen reader there. */}
      <span className="sr-only sm:not-sr-only">{hangarPillLabel(status, at)}</span>
    </span>
  );
}
