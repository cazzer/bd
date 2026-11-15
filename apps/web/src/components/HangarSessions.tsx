// A work item's hangar sessions in the board drawer (hangar-release, tasks.md
// 1.4): one row per session, newest-changed first (`hangarSessions`), and
// the section is left off while the item has none. Each row shows the
// session's state as a chip, its flavor and host, hangar's failure reason
// when it failed, and what became of it: the person's outcome and when,
// then "released" (hangar has deleted or kept the disk and holds nothing
// for it) or "disk held".
//
// An ended session (stopped or failed) without an outcome takes one here.
// Either outcome releases the session: at its next check-in hangar removes
// the container, deletes the disk, and acknowledges (docs/hangar-api.md
// "Releasing sessions"). Accept says the work is done or kept; Table sets it
// aside. Both delete the disk, so both ask first, inline (no browser
// confirm): the outcome's warning and an explicit "Accept session" or
// "Table session" button, which takes focus when the confirmation opens;
// Cancel puts focus back on the button that opened it. Until hangar has
// released the session, the outcome can be changed ("Change to …", which
// asks the same way). A refusal (the session moved on: hangar released it,
// or it is no longer ended) is shown on the row in the server's words,
// written for the person (server/errors.ts), and the list is read again.
// Every control is at least 44 px tall below `sm`.
//
// It reads on mount and whenever the host's source re-reads (`version`),
// keeping the previous answer on screen meanwhile; a failed read is said on
// the section when there is one to say it on, and leaves it off otherwise.

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.js";
import { SectionTitle } from "./ReviewAttachments.js";

type SessionsAnswer = Awaited<ReturnType<typeof trpc.hangarSessions.query>>;
type Session = SessionsAnswer["sessions"][number];
type Outcome = "accepted" | "tabled";
type OutcomeSet = Awaited<ReturnType<typeof trpc.hangarSessionOutcome.mutate>>;

export const ACCEPT_WARNING = "Accepting releases this session: hangar removes its container and deletes its disk at its next check-in.";
export const TABLE_WARNING = "Tabling releases this session: hangar removes its container and deletes its disk at its next check-in.";

const CONFIRM: Record<Outcome, { warning: string; label: string; group: string; tone: string }> = {
  accepted: { warning: ACCEPT_WARNING, label: "Accept session", group: "Confirm accepting", tone: "bg-accent text-ground hover:bg-accent/90" },
  tabled: { warning: TABLE_WARNING, label: "Table session", group: "Confirm tabling", tone: "bg-red-500/80 text-white hover:bg-red-500" },
};

const ENDED: readonly Session["state"][] = ["stopped", "failed"];

export interface HangarSessionsProps {
  /** The work item's node id. */
  workItemId: string;
  /** Bumped by the host after every read of its source; the section re-reads on it. */
  version: number;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== "" ? err.message : fallback;
}

export function HangarSessions({ workItemId, version }: HangarSessionsProps) {
  const [answer, setAnswer] = useState<SessionsAnswer | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const read = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const next = await trpc.hangarSessions.query({ workItemId });
      if (signal.cancelled) return;
      setAnswer(next);
      setReadError(null);
    } catch (err) {
      if (!signal.cancelled) setReadError(messageOf(err, "Could not read this item's hangar sessions."));
    }
  }, [workItemId]);

  useEffect(() => {
    const signal = { cancelled: false };
    void read(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [read, version]);

  /** A write's answer, shown at once on its row; the re-read that follows confirms it. */
  const written = useCallback(
    (set: OutcomeSet) => {
      setAnswer((a) =>
        a === null ? a : { ...a, sessions: a.sessions.map((s) => (s.id === set.id ? { ...s, state: set.state, outcome: set.outcome, outcomeAt: set.outcomeAt, outcomeBy: set.outcomeBy, released: set.released } : s)) },
      );
    },
    [],
  );

  const sessions = answer?.sessions ?? [];
  if (sessions.length === 0) return null;

  return (
    <section data-hangar-sessions="">
      <SectionTitle>Hangar sessions</SectionTitle>
      {readError !== null && (
        <p role="alert" className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Could not refresh the sessions: {readError}
        </p>
      )}
      <ul className="space-y-2.5">
        {sessions.map((s) => (
          <SessionRow key={s.id} session={s} onWritten={written} onSettled={() => void read({ cancelled: false })} />
        ))}
      </ul>
      {answer?.truncated && <p className="mt-2 text-xs text-fg-muted">Showing the {sessions.length} most recently changed.</p>}
    </section>
  );
}

function stateTone(state: Session["state"]): string {
  switch (state) {
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-300";
    case "stopped":
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
    case "running":
    case "claimed":
      return "border-amber-400/50 bg-amber-400/10 text-amber-200";
    default:
      return "border-hairline text-fg-muted";
  }
}

const OUTCOME_WORD: Record<Outcome, string> = { accepted: "Accepted", tabled: "Tabled" };

const BUTTON = "min-h-11 rounded-lg px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:min-h-8";

interface SessionRowProps {
  session: Session;
  /** The outcome was set; the answer's fields. */
  onWritten: (set: OutcomeSet) => void;
  /** A write answered, either way: read the list again. */
  onSettled: () => void;
}

type Opener = "accept" | "table" | "change";

function SessionRow({ session: shown, onWritten, onSettled }: SessionRowProps) {
  const [confirming, setConfirming] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openers: Record<Opener, React.RefObject<HTMLButtonElement | null>> = { accept: useRef(null), table: useRef(null), change: useRef(null) };
  /** The button that opened the confirmation, focused again on Cancel. */
  const opener = useRef<Opener | null>(null);
  const restoreFocus = useRef(false);

  const ended = ENDED.includes(shown.state);
  const outcome = shown.outcome;
  const decidable = ended && !shown.released;

  useEffect(() => {
    if (confirming !== null) {
      confirmRef.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      if (opener.current !== null) openers[opener.current].current?.focus();
    }
    // `openers` holds stable refs; only the confirmation opening or closing moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming]);

  function ask(next: Outcome, from: Opener) {
    opener.current = from;
    setConfirming(next);
  }

  function cancel() {
    restoreFocus.current = true;
    setConfirming(null);
  }

  async function setOutcome(next: Outcome) {
    setPending(true);
    setRefusal(null);
    try {
      onWritten(await trpc.hangarSessionOutcome.mutate({ id: shown.id, outcome: next }));
      setConfirming(null);
    } catch (err) {
      setRefusal(messageOf(err, "Could not set the session's outcome."));
      setConfirming(null);
    } finally {
      setPending(false);
    }
    onSettled();
  }

  const where = [shown.flavor, shown.host === null ? null : `on ${shown.host}`, shown.container === null ? null : `container ${shown.container}`].filter((p) => p !== null).join(" · ");

  return (
    <li data-hangar-session={shown.id} className="rounded-lg border border-hairline bg-surface-strong px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span data-session-state={shown.state} className={`rounded-full border px-2 py-0.5 text-[11px] ${stateTone(shown.state)}`}>
          {shown.state}
        </span>
        <span className="min-w-0 break-words text-fg">{where}</span>
        <span className="ml-auto text-[11px] text-fg-muted">
          <time dateTime={shown.updatedAt}>{formatTime(shown.updatedAt)}</time>
        </span>
      </div>
      {shown.state === "failed" && shown.failureReason !== null && (
        <p data-failure-reason="" className="mt-1 break-words text-red-300">
          Failed: {shown.failureReason}
        </p>
      )}
      {shown.state === "queued" && shown.requeueReason !== null && <p className="mt-1 break-words text-fg-muted">Requeued: {shown.requeueReason}</p>}
      {outcome !== null ? (
        <p data-session-outcome={outcome} className="mt-1 text-fg">
          {OUTCOME_WORD[outcome]}
          {shown.outcomeAt !== null && (
            <>
              {" "}
              <time dateTime={shown.outcomeAt}>{formatTime(shown.outcomeAt)}</time>
            </>
          )}
          {shown.outcomeBy !== null && <span className="text-fg-muted"> by {shown.outcomeBy}</span>}
          <span className="text-fg-muted"> · </span>
          {shown.released ? <span data-session-release="released">released</span> : <span data-session-release="held">disk held</span>}
        </p>
      ) : (
        ended && <p className="mt-1 text-fg-muted">{shown.diskHeld ? "Ended · disk held, waiting for your decision" : "Ended · waiting for your decision"}</p>
      )}

      {decidable && confirming === null && outcome === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button ref={openers.accept} type="button" disabled={pending} onClick={() => ask("accepted", "accept")} className={`${BUTTON} bg-accent text-ground hover:bg-accent/90`}>
            Accept
          </button>
          <button ref={openers.table} type="button" disabled={pending} onClick={() => ask("tabled", "table")} className={`${BUTTON} border border-hairline text-fg hover:bg-surface`}>
            Table
          </button>
        </div>
      )}
      {decidable && confirming === null && outcome !== null && (
        <button
          ref={openers.change}
          type="button"
          disabled={pending}
          onClick={() => ask(outcome === "accepted" ? "tabled" : "accepted", "change")}
          className="mt-1 inline-flex min-h-11 items-center rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:min-h-0"
        >
          Change to {outcome === "accepted" ? "tabled" : "accepted"}
        </button>
      )}
      {decidable && confirming !== null && (
        <div role="group" aria-label={CONFIRM[confirming].group} className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2">
          <p className="text-amber-200">{CONFIRM[confirming].warning}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button ref={confirmRef} type="button" disabled={pending} onClick={() => void setOutcome(confirming)} className={`${BUTTON} ${CONFIRM[confirming].tone}`}>
              {CONFIRM[confirming].label}
            </button>
            <button type="button" disabled={pending} onClick={cancel} className={`${BUTTON} text-fg-muted hover:text-fg`}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {refusal !== null && (
        <p role="alert" className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-300">
          {refusal}
        </p>
      )}
    </li>
  );
}
