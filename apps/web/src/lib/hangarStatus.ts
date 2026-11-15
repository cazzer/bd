// Pure helpers behind the board header's hangar pill (hangar-queue design
// decision 7): what the chip says, the open counts it shows beside that,
// whether it shows at all, and what its tooltip adds, the latest capacity's
// free slots and blocked flavors among it (hangar-capacity). Also the two the
// drawer's hangar sessions use for a session waiting on review: where its
// work item opens and how its disk reads. Liveness is decided by the server
// against its own clock (`hangarStatus`); these only word it. Times read in
// the browser's local zone: the time alone when the last check-in was today,
// the date too when it was not. Structural types only, so nothing from the
// server reaches the bundle.

import type { Route } from "./route.js";

/** The slice of the `hangarStatus` answer these helpers read. */
export interface HangarStatusView {
  status: "online" | "offline" | "never";
  hangar: string | null;
  version: string | null;
  lastSeenAt: string | null;
  queued: number;
  claimed: number;
  running: number;
  /** The slice of hangar's latest capacity the tooltip shows; null when it sent none. */
  capacity: { slots?: Record<string, number>; blocked?: Record<string, string> } | null;
  capacityAt: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number): string => String(n).padStart(2, "0");

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "09:00" today, "Nov 12, 09:00" earlier this year, "Nov 12, 2025, 09:00" before that; seconds when asked. Shared with the relay pill (relayStatus.ts). */
export function formatInstant(at: Date, now: Date, seconds = false): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}${seconds ? `:${pad(at.getSeconds())}` : ""}`;
  if (sameLocalDay(at, now)) return time;
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? `${day}, ${time}` : `${day}, ${at.getFullYear()}, ${time}`;
}

function instant(iso: string | null): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

const lastSeen = (status: HangarStatusView): Date | null => instant(status.lastSeenAt);

/** "hangar online", "hangar offline since 09:00" (or "since Nov 12, 09:00"), or "hangar never checked in". */
export function hangarPillLabel(status: HangarStatusView, now: Date): string {
  if (status.status === "online") return "hangar online";
  const at = lastSeen(status);
  if (status.status === "never" || at === null) return "hangar never checked in";
  return `hangar offline since ${formatInstant(at, now)}`;
}

/** The capacity lines: free slots ("Slots: headless 2, display-browser 1", or "No free slots"), one line per blocked flavor, and when it was reported. */
function capacityLines(status: HangarStatusView, now: Date): string[] {
  const { capacity } = status;
  if (capacity === null) return status.status === "online" ? ["No capacity reported"] : [];
  const free = Object.entries(capacity.slots ?? {}).filter(([, n]) => n > 0);
  const lines = [free.length === 0 ? "No free slots" : `Slots: ${free.map(([flavor, n]) => `${flavor} ${n}`).join(", ")}`];
  for (const [flavor, reason] of Object.entries(capacity.blocked ?? {})) lines.push(`${flavor} blocked: ${reason}`);
  const reported = instant(status.capacityAt);
  if (reported !== null) lines.push(`Capacity reported ${formatInstant(reported, now, true)}`);
  return lines;
}

/** The tooltip: which hangar, its version, its last check-in, its capacity, and the open session counts, one per line. */
export function hangarPillTitle(status: HangarStatusView, now: Date): string {
  const at = lastSeen(status);
  const who = status.hangar === null ? "No hangar has checked in" : `${status.hangar}${status.version === null ? "" : ` ${status.version}`}`;
  const lines = [who];
  if (at !== null) lines.push(`Last check-in ${formatInstant(at, now, true)}`);
  lines.push(...capacityLines(status, now));
  lines.push(`${status.queued} queued · ${status.claimed} claimed · ${status.running} running`);
  return lines.join("\n");
}

/** The open session counts the chip shows inline, zeros left out ("1 queued, 1 running"); null when there are none. */
export function hangarPillCounts(status: HangarStatusView): string | null {
  const parts = (
    [
      [status.queued, "queued"],
      [status.claimed, "claimed"],
      [status.running, "running"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`);
  return parts.length === 0 ? null : parts.join(", ");
}

/** Nothing to say: no hangar has ever checked in and no session is open, so the chip is left off the header. */
export function hangarPillHidden(status: HangarStatusView): boolean {
  return status.status === "never" && status.queued + status.claimed + status.running === 0;
}

/** Where an awaiting-review session's work item opens: its project's board with it in the drawer (keyed by external id, the bead id), else the graph with it selected. */
export function awaitingWorkItemRoute(workItem: { id: string; externalId: string; project: string | null }): Route {
  if (workItem.project !== null) return { view: "board", viewId: null, projects: [workItem.project], item: workItem.externalId };
  return { view: "graph", q: null, types: [], node: workItem.id };
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"];

/** A disk's size in binary units with one decimal ("8.0 GB", "512.0 MB"); bytes under 1 KB as a whole number ("512 B"). */
export function formatDiskBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
