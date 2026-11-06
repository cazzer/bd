// "Go to agent" and "Talk it through" on any decision card (review-sessions;
// unify-review-queues, design.md decision 5): the first brings the agent or
// session already on the item to the front, the second opens a new herdr
// tab with an agent primed on the item. Neither writes a decision. The host
// passes the two calls; herdr's own failure (the pane is gone) is shown in
// one line.

import { useState } from "react";

export type SessionLinkResult = { ok: true; tab: string } | { ok: false; reason: string };

export interface SessionLinksProps {
  /** There is an agent or session to go to. */
  canFocus: boolean;
  /** "Go to agent" for a review; "Go to session" for an inbox item handed to one. */
  focusLabel?: string;
  focus: () => Promise<SessionLinkResult>;
  open: () => Promise<SessionLinkResult>;
}

export function SessionLinks({ canFocus, focusLabel = "Go to agent", focus, open }: SessionLinksProps) {
  const [busy, setBusy] = useState<"focus" | "open" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function go(mode: "focus" | "open") {
    setBusy(mode);
    setStatus(null);
    try {
      const result = await (mode === "focus" ? focus() : open());
      if (result.ok) setStatus({ tone: "ok", text: mode === "focus" ? `Switched to tab ${result.tab}.` : `Opened a session in herdr tab ${result.tab}.` });
      else setStatus({ tone: "error", text: mode === "focus" ? `Couldn't switch: ${result.reason}` : `Couldn't open a session: ${result.reason}` });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const button =
    "rounded-md px-2 py-1 text-xs text-accent hover:bg-accent/10 hover:underline focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60";
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-fg-muted">
      <span>Need more context?</span>
      {canFocus && (
        <button type="button" className={button} disabled={busy !== null} onClick={() => void go("focus")} title="Bring the agent or session already on this item to the front in herdr">
          {busy === "focus" ? "Switching…" : focusLabel}
        </button>
      )}
      <button type="button" className={button} disabled={busy !== null} onClick={() => void go("open")} title="Open a new herdr tab with an agent primed on this item">
        {busy === "open" ? "Opening…" : "Talk it through ↗"}
      </button>
      {status !== null && (
        <span role={status.tone === "error" ? "alert" : "status"} className={`basis-full ${status.tone === "error" ? "text-red-300" : "text-emerald-300"}`}>
          {status.text}
        </span>
      )}
    </div>
  );
}
