// The board header's relay chip (laptop-relay design.md decision 8): "relay
// online", "relay offline since …", or "relay never checked in", then the
// open action count when there is one ("· 2 pending"), with the relay's
// name, version, last check-in, the counts, and what this server lacks in
// its tooltip. It shows only when it matters: the server lacks `bd` or
// `herdr`, or actions are open. On phones the words give way to the dot,
// but the count stays. A status chip, not a control, like the hangar chip
// beside it (HangarStatusPill.tsx), which it mirrors; it reads through
// useRelayStatus, and disappears while reads fail.

import { relayPillHidden, relayPillLabel, relayPillPending, relayPillTitle, type RelayStatusView } from "../lib/relayStatus.js";
import { useRelayStatus } from "../lib/useRelayStatus.js";

/** Filled = online, ring = offline, dashed ring = never: the shape carries the state, not only the colour. */
function RelayLight({ status }: { status: RelayStatusView["status"] }) {
  const cls =
    status === "online"
      ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]"
      : status === "offline"
        ? "border-[1.5px] border-red-400"
        : "border-[1.5px] border-dashed border-fg-muted";
  return <span aria-hidden="true" data-relay={status} className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

export function RelayStatusPill() {
  const polled = useRelayStatus();
  if (polled === null || relayPillHidden(polled.status)) return null;
  const { status, at } = polled;
  const pending = relayPillPending(status);

  return (
    <span
      role="status"
      title={relayPillTitle(status, at)}
      data-relay-pill={status.status}
      className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-hairline px-3 text-xs whitespace-nowrap text-fg-muted"
    >
      <RelayLight status={status.status} />
      {/* The dot and the count on phones, where the header is tight; the words stay readable to a screen reader there. */}
      <span className="sr-only sm:not-sr-only">
        {relayPillLabel(status, at)}
        {pending === null ? "" : " ·"}
      </span>
      {pending === null ? null : <span data-relay-pending="">{` ${pending}`}</span>}
    </span>
  );
}
