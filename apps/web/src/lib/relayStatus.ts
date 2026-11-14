// Pure helpers behind the board header's relay pill (laptop-relay design.md
// decision 8): what the chip says, the pending count beside it, whether it
// shows at all, and what its tooltip adds. Liveness is decided by the
// server against its own clock (`relayStatus`); these only word it, in the
// browser's local zone, as the hangar pill does (hangarStatus.ts, whose
// `formatInstant` this shares). Structural types only, so nothing from the
// server reaches the bundle.

import { formatInstant } from "./hangarStatus.js";

/** The slice of the `relayStatus` answer these helpers read. */
export interface RelayStatusView {
  status: "online" | "offline" | "never";
  relay: string | null;
  version: string | null;
  lastSeenAt: string | null;
  queued: number;
  claimed: number;
  /** Host binaries the server lacks, whose work it queues for the relay. */
  missingBinaries: readonly string[];
}

function lastSeen(status: RelayStatusView): Date | null {
  if (status.lastSeenAt === null) return null;
  const at = new Date(status.lastSeenAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "relay online", "relay offline since 09:00" (or "since Nov 12, 09:00"), or "relay never checked in". */
export function relayPillLabel(status: RelayStatusView, now: Date): string {
  if (status.status === "online") return "relay online";
  const at = lastSeen(status);
  if (status.status === "never" || at === null) return "relay never checked in";
  return `relay offline since ${formatInstant(at, now)}`;
}

/** The tooltip: which relay, its version, its last check-in, the open action counts, and what this server lacks, one per line. */
export function relayPillTitle(status: RelayStatusView, now: Date): string {
  const at = lastSeen(status);
  const who = status.relay === null ? "No laptop relay has checked in" : `${status.relay}${status.version === null ? "" : ` ${status.version}`}`;
  const lines = [who];
  if (at !== null) lines.push(`Last check-in ${formatInstant(at, now, true)}`);
  lines.push(`${status.queued} queued · ${status.claimed} claimed`);
  if (status.missingBinaries.length > 0) lines.push(`This server has no ${status.missingBinaries.join(" or ")}; that work waits for the relay`);
  return lines.join("\n");
}

/** "2 pending" (queued and claimed together); null when nothing is open. */
export function relayPillPending(status: RelayStatusView): string | null {
  const open = status.queued + status.claimed;
  return open === 0 ? null : `${open} pending`;
}

/** The relay is beside the point: this server has `bd` and `herdr` and nothing is open, so the chip is left off. */
export function relayPillHidden(status: RelayStatusView): boolean {
  return status.missingBinaries.length === 0 && status.queued + status.claimed === 0;
}
