// Pure helpers behind the board header's hangar pill (hangar-queue design
// decision 7): what the chip says, the open counts it shows beside that,
// whether it shows at all, and what its tooltip adds. Liveness is
// decided by the server against its own clock (`hangarStatus`); these only
// word it. Times read in the browser's local zone: the time alone when the
// last check-in was today, the date too when it was not. Structural types
// only, so nothing from the server reaches the bundle.

/** The slice of the `hangarStatus` answer these helpers read. */
export interface HangarStatusView {
  status: "online" | "offline" | "never";
  hangar: string | null;
  version: string | null;
  lastSeenAt: string | null;
  queued: number;
  claimed: number;
  running: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number): string => String(n).padStart(2, "0");

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "09:00" today, "Nov 12, 09:00" earlier this year, "Nov 12, 2025, 09:00" before that; seconds when asked. */
function formatInstant(at: Date, now: Date, seconds = false): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}${seconds ? `:${pad(at.getSeconds())}` : ""}`;
  if (sameLocalDay(at, now)) return time;
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? `${day}, ${time}` : `${day}, ${at.getFullYear()}, ${time}`;
}

function lastSeen(status: HangarStatusView): Date | null {
  if (status.lastSeenAt === null) return null;
  const at = new Date(status.lastSeenAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "hangar online", "hangar offline since 09:00" (or "since Nov 12, 09:00"), or "hangar never checked in". */
export function hangarPillLabel(status: HangarStatusView, now: Date): string {
  if (status.status === "online") return "hangar online";
  const at = lastSeen(status);
  if (status.status === "never" || at === null) return "hangar never checked in";
  return `hangar offline since ${formatInstant(at, now)}`;
}

/** The tooltip: which hangar, its version, its last check-in, and the open session counts, one per line. */
export function hangarPillTitle(status: HangarStatusView, now: Date): string {
  const at = lastSeen(status);
  const who = status.hangar === null ? "No hangar has checked in" : `${status.hangar}${status.version === null ? "" : ` ${status.version}`}`;
  const lines = [who];
  if (at !== null) lines.push(`Last check-in ${formatInstant(at, now, true)}`);
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
