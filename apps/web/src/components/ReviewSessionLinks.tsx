// "Go to agent" and "Talk it through" on an open review (review-sessions):
// the first brings the requesting agent's herdr pane to the front, the
// second opens a new herdr tab with an agent primed on the review, in the
// project's checkout. Neither writes anything; the decision is still made
// here. herdr's own failure (the pane is gone) is shown in one line.

import { useState } from "react";
import { trpc } from "../trpc.js";

export interface ReviewSessionLinksProps {
  project: string;
  item: string;
  /** The requesting agent's pane and session were recorded, so there is one to go to. */
  hasRequester: boolean;
}

export function ReviewSessionLinks({ project, item, hasRequester }: ReviewSessionLinksProps) {
  const [busy, setBusy] = useState<"focus" | "open" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function go(mode: "focus" | "open") {
    setBusy(mode);
    setStatus(null);
    try {
      const result = await trpc.reviewSession.mutate({ project, item, mode });
      if (result.ok) setStatus({ tone: "ok", text: mode === "focus" ? `Switched to the agent's tab (${result.tab}).` : `Opened a session in herdr tab ${result.tab}.` });
      else setStatus({ tone: "error", text: mode === "focus" ? `Couldn't go to the agent: ${result.reason}` : `Couldn't open a session: ${result.reason}` });
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
      {hasRequester && (
        <button type="button" className={button} disabled={busy !== null} onClick={() => void go("focus")} title="Bring the agent that asked for this review to the front in herdr">
          {busy === "focus" ? "Switching…" : "Go to agent"}
        </button>
      )}
      <button type="button" className={button} disabled={busy !== null} onClick={() => void go("open")} title="Open a new herdr tab with an agent primed on this review">
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
