// The shell header's hangar chip (hangar-queue design decision 7): "hangar
// online", "hangar offline since …", or "hangar never checked in", then the
// open session counts when there are any ("· 1 queued, 1 running"), with
// the hangar's name, version, last check-in, its latest capacity (free slots
// per flavor, why each blocked flavor is blocked, and when that was
// reported; hangar-capacity), and every count in its tooltip. When an online
// hangar's fresh capacity has no slot for any flavor, the chip says so
// ("· disk full" or "· no slots"). On phones the words give way to the dot,
// but the capacity note and the counts stay: they are what changes. With no hangar ever checked in and nothing open
// the chip is left off. A status chip, not a control: it takes no focus and
// has no action, so it needs no phone-sized hit target.
//
// It reads `hangarStatus` on mount, every POLL_MS while the tab is visible,
// and at once when the tab becomes visible again; a hidden tab makes no
// requests. Each answer also moves the clock the label is worded against,
// so "since 09:00" gains its date once the day turns. If a read fails the
// chip disappears until one succeeds: hangar's status is a side note on the
// board, and the board's own reads already surface a lost connection.
//
// The shell header (shared-nav-header) polls once with `useHangarStatus`
// and draws `HangarStatusChip`, `compact` where its row is tight — chosen by
// the header's own width tiers, not the viewport's `sm`: the dot, the
// capacity note, and the open sessions as one number, with the words and
// the per-state counts kept for screen readers (and in the tooltip).

import { useEffect, useState } from "react";
import { hangarPillCapacity, hangarPillCounts, hangarPillHidden, hangarPillLabel, hangarPillTitle, type HangarStatusView } from "../lib/hangarStatus.js";
import { trpc } from "../trpc.js";

export const HANGAR_POLL_MS = 30_000;

export interface PolledHangarStatus {
  status: HangarStatusView;
  /** When the answer arrived, in the browser's clock: what the label is worded against. */
  at: Date;
}

/** The latest `hangarStatus`, or null before the first answer and after a failed read. */
export function useHangarStatus(): PolledHangarStatus | null {
  const [polled, setPolled] = useState<PolledHangarStatus | null>(null);

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

/** Whether the chip would show hangar offline: what a closed menu holding it flags. */
export function hangarShownOffline(polled: PolledHangarStatus | null): boolean {
  return polled !== null && !hangarPillHidden(polled.status) && polled.status.status === "offline";
}

export interface HangarStatusChipProps {
  polled: PolledHangarStatus | null;
  /** The dot and the counts only at every width; the words stay for screen readers. */
  compact?: boolean;
}

export function HangarStatusChip({ polled, compact = false }: HangarStatusChipProps) {
  if (polled === null || hangarPillHidden(polled.status)) return null;
  const { status, at } = polled;
  const counts = hangarPillCounts(status);
  const full = hangarPillCapacity(status);

  return (
    <span
      role="status"
      title={hangarPillTitle(status, at)}
      data-hangar-pill={status.status}
      className={`inline-flex h-7 shrink-0 items-center rounded-full border border-hairline text-xs whitespace-nowrap text-fg-muted ${compact ? "gap-1.5 px-2.5" : "gap-2 px-3"}`}
    >
      <HangarLight status={status.status} />
      {/* The dot and the counts on phones, where the header is tight; the words stay readable to a screen reader there. */}
      <span className={compact ? "sr-only" : "sr-only sm:not-sr-only"}>
        {hangarPillLabel(status, at)}
        {full === null && counts === null ? "" : " ·"}
      </span>
      {full === null ? null : <span data-hangar-capacity={full}>{` ${full}${counts === null || compact ? "" : " ·"}`}</span>}
      {counts === null ? null : compact ? (
        <>
          <span className="sr-only">{` ${counts}`}</span>
          <span aria-hidden="true" data-hangar-counts="" className="tabular-nums">
            {status.queued + status.claimed + status.running}
          </span>
        </>
      ) : (
        <span data-hangar-counts="">{` ${counts}`}</span>
      )}
    </span>
  );
}
