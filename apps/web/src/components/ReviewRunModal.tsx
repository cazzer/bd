// The review-all run-through (review-queue, design.md decision 6): a modal
// dialog over the current view that walks the queue one review at a time,
// in the spirit of a store's discovery queue. ReviewQueueProvider mounts it
// when the popover's "Review all" is pressed and unmounts it to end the
// run; the view and its address never change.
//
// A native <dialog> opened with showModal(), as the Lightbox is: the
// browser puts it in the top layer, makes the rest of the page inert, keeps
// Tab inside it, and fires `cancel` on Escape — and undoes all of it when
// the dialog closes or unmounts. React carries a nested dialog's `cancel`
// and `close` (the Lightbox's) up to this one's handlers, so they act only
// on their own events (lib/dialogEvents.ts).
//
// Leaving. Escape and Close (✕) both ask to leave: while a decision is
// being written they do nothing (the write's answer decides what comes
// next); once anything has been answered they stop the run and show the
// summary, and from the summary (or with nothing answered yet) they end it.
// Escape inside the review panel with a draft in the box does nothing, as
// in the drawer (the panel takes the key). A dialog the browser closes on
// its own also ends the run, so state and screen never disagree. The
// provider returns focus to the pill.
//
// The run (lib/reviewRun.ts) is the queue's order when opened; reviews
// that join the live queue meanwhile join its end. The header shows "n of
// m" (m+ while the queue's read is truncated), a progress bar, and a
// status line at every width that says what the last answer was and where
// the run is now ("Accepted “…”. 2 of 3."), plus whether the agent could not
// be told, kept until the next decision. The body is ReviewItemPanel for
// the review on screen, keyed on it, so each review mounts fresh and its
// title takes focus; from `lg` up it uses the panel's `stage` layout (the
// screenshots fill the left two thirds), below it the drawer's column.
//
// Deciding. "Accept & next" and "Request changes & next" (a message is
// required, as in the drawer; "Accept" / "Changes" below `sm`, on one row
// with "Skip"); a decision card with options offers "Accept <recommended>",
// "Choose <other>" (each marked "& next"), and "Request changes & next"
// instead (ReviewItemPanel.tsx), and its attachments take the stage — a
// diff fills it, a before/after pair sits above a diagram. The run moves on only when the panel reports the decision
// written (`ok`), so a failure, a partial write, or an uncertain thrown
// call stays on the review with the panel's own messages. The panel arms
// its decisions 500 ms after a review mounts (and its shortcuts only after
// a key is released), so a double click or a held Cmd+Enter decides one
// review, not the next. "Skip" moves on without writing, and is disabled
// while a write is in flight. Once the review on screen has left the live
// queue the form gives way to a note that it was decided elsewhere and
// will not count, and "Skip" reads "Next". Drafts go through the shell's
// shared map, so a message typed here is the one the drawer shows for the
// same review, and back. "Open in graph" is hidden: it would leave the run.
//
// Keyboard: Ctrl/Cmd+Enter is "Accept & next" (on a card, accepting the
// recommended option, whose id the hint names), Ctrl/Cmd+Shift+Enter
// "Request changes & next" (with no message it focuses the box and asks for
// one); choosing another option has no shortcut. No plain key is ever taken, so typing is never intercepted.
//
// The end is a summary — accepted, changes requested, skipped, and the run's
// reviews with what became of each — with "Close" and, when any review of
// the run is still pending and undecided (skipped, or not reached when the
// run was stopped), a button that starts a new run over those. Focus lands
// on its heading. No state is stored; closing ends the run.

import { useEffect, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { isOwnDialogEvent } from "../lib/dialogEvents.js";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import type { ReviewDecisionKind } from "../lib/reviewDrawer.js";
import {
  answerRun,
  currentPending,
  currentReview,
  finishRun,
  leftPending,
  runLog,
  runProgress,
  runTallies,
  startRun,
  syncRun,
  type ReviewRun,
  type RunEntryResult,
  type RunResult,
} from "../lib/reviewRun.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { storeDraft } from "./ReviewQueue.js";
import { ReviewItemPanel, type PanelDecisions, type WrittenReport } from "./ReviewItemPanel.js";

type QueueReview = ReviewQueueState["reviews"][number];

export interface ReviewRunModalProps {
  queue: ReviewQueueState;
  /** The shell's shared draft map, by bead id. */
  drafts: Map<string, string>;
  /** End the run (see the header). */
  onEnd: () => void;
}

/** Tailwind's `lg`: from here the run gives screenshots a stage beside the form. */
const STAGE_QUERY = "(min-width: 64rem)";

/** Decisions are ignored this long after a review appears. */
const ARM_AFTER_MS = 500;

function quoted(review: QueueReview): string {
  return `“${review.title.trim() || review.externalId}”`;
}

const ANSWER_TEXT: Readonly<Record<RunResult, (title: string) => string>> = {
  accepted: (t) => `Accepted ${t}.`,
  changes: (t) => `Changes requested on ${t}.`,
  skipped: (t) => `Skipped ${t}.`,
};

interface StatusLine {
  text: string;
  /** The agent could not be told of the last decision; kept until the next one. */
  warning: string | null;
}

export function ReviewRunModal({ queue, drafts, onEnd }: ReviewRunModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const eyebrowId = useId();
  const progressId = useId();
  const titleId = useId();
  const [run, setRunState] = useState<ReviewRun<QueueReview>>(() => startRun(queue.reviews));
  const runRef = useRef(run);
  const [status, setStatus] = useState<StatusLine | null>(null);
  const [busy, setBusy] = useState(false);
  /** Reviews this run wrote something to, so their leaving the queue is not "decided elsewhere". */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const live = useRef(queue.reviews);
  live.current = queue.reviews;
  const staged = useMediaQuery(STAGE_QUERY);

  function setRun(next: ReviewRun<QueueReview>) {
    runRef.current = next;
    setRunState(next);
  }

  // Before paint, so the dialog never shows un-modal for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const next = syncRun(runRef.current, queue.reviews);
    if (next !== runRef.current) setRun(next);
  }, [queue.reviews]);

  function positionText(next: ReviewRun<QueueReview>): string {
    if (next.done) return "Run complete.";
    const p = runProgress(next, live.current);
    return `${p.position} of ${p.total}${queue.truncated ? "+" : ""}.`;
  }

  function answer(review: QueueReview, result: RunResult | null, report?: WrittenReport) {
    const next = answerRun(runRef.current, live.current, review.id, result);
    if (next === runRef.current) return;
    setRun(next);
    const said = result === null ? `Moved past ${quoted(review)}.` : ANSWER_TEXT[result](quoted(review));
    setStatus((prev) => ({
      text: `${said} ${positionText(next)}`,
      warning: report !== undefined ? (report.notifyFailed ? report.notified : null) : (prev?.warning ?? null),
    }));
  }

  function requestLeave() {
    if (busy) return;
    const current = runRef.current;
    if (!current.done && current.results.size > 0) {
      setRun(finishRun(current));
      setStatus((prev) => (prev === null ? null : { ...prev, text: "Run stopped." }));
    } else {
      onEnd();
    }
  }

  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    if (!isOwnDialogEvent(e)) return;
    e.preventDefault();
    requestLeave();
  }

  // Only a dialog still closed ends the run: StrictMode's remount closes and
  // reopens it, and that close event arrives after it is open again.
  function onClosed(e: SyntheticEvent<HTMLDialogElement>) {
    if (!isOwnDialogEvent(e)) return;
    if (!e.currentTarget.open) onEnd();
  }

  function reviewLeft() {
    setRun(syncRun(startRun(leftPending(runRef.current, live.current)), live.current));
    setStatus(null);
  }

  const review = currentReview(run);
  const progress = runProgress(run, queue.reviews);
  const stillPending = currentPending(run, queue.reviews);
  const totalText = `${progress.total}${queue.truncated ? "+" : ""}`;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={review !== null ? `${eyebrowId} ${progressId} ${titleId}` : `${eyebrowId} ${titleId}`}
      onCancel={onCancel}
      onClose={onClosed}
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-surface-strong p-0 text-fg backdrop-blur-xl backdrop:bg-black/70 open:flex sm:m-auto sm:h-[min(58rem,calc(100dvh-3rem))] sm:w-[min(68rem,calc(100vw-3rem))] sm:rounded-2xl sm:border sm:border-hairline sm:shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)] lg:w-[min(86rem,calc(100vw-3rem))]"
    >
      <header className="border-b border-hairline px-4 py-3 sm:px-5">
        <div className="flex items-center gap-4">
          <div className="shrink-0">
            <p id={eyebrowId} className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Review all
            </p>
            <p id={progressId} className="text-lg font-semibold tabular-nums leading-tight text-fg">
              {review !== null ? (
                <>
                  {progress.position} <span className="font-normal text-fg-muted">of</span> {totalText}
                </>
              ) : (
                "Done"
              )}
            </p>
          </div>
          <ProgressBar position={review !== null ? progress.position - 1 : progress.total} total={progress.total} />
          <button
            type="button"
            aria-label={review !== null && run.results.size > 0 ? "Stop and show the summary" : "Close review all"}
            onClick={requestLeave}
            disabled={busy}
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 sm:size-9"
          >
            ✕
          </button>
        </div>
        <p role="status" className="mt-1.5 min-h-4 truncate text-xs text-fg-muted">
          {status?.text}
          {status?.warning && <span className="text-amber-200"> {status.warning}.</span>}
        </p>
      </header>

      {review !== null ? (
        <ReviewItemPanel
          key={review.id}
          project={review.project}
          item={review.externalId}
          boardLoaded
          boardVersion={queue.version}
          initialDraft={drafts.get(review.externalId) ?? ""}
          onDraftChange={(draft) => storeDraft(drafts, review.externalId, draft)}
          onDecided={() => setTouched((prev) => new Set(prev).add(review.id))}
          onProjectConfirmed={() => {}}
          onEscape={requestLeave}
          onBusyChange={setBusy}
          titleId={titleId}
          showGraphLink={false}
          layout={staged ? "stage" : "column"}
          decisions={runDecisions(review, stillPending, touched.has(review.id), answer)}
        />
      ) : (
        <RunSummary titleId={titleId} run={run} live={queue.reviews} onReviewLeft={reviewLeft} onClose={onEnd} />
      )}
    </dialog>
  );
}

function runDecisions(review: QueueReview, stillPending: boolean, touched: boolean, answer: (review: QueueReview, result: RunResult | null, report?: WrittenReport) => void): PanelDecisions {
  return {
    acceptLabel: "Accept & next",
    changesLabel: "Request changes & next",
    acceptShort: "Accept",
    changesShort: "Changes",
    optionSuffix: "& next",
    shortcuts: true,
    armAfterMs: ARM_AFTER_MS,
    onWritten: (decision: ReviewDecisionKind, report: WrittenReport) => answer(review, decision === "accept" ? "accepted" : "changes", report),
    notice: stillPending ? undefined : touched ? "This review has left the queue after the write above — check its thread, then move on." : "Decided elsewhere — this review left the queue and won't count in your tally.",
    extra: ({ busy }) => (
      <button
        type="button"
        onClick={() => answer(review, stillPending ? "skipped" : null)}
        disabled={busy}
        className="min-h-11 rounded-lg border border-hairline px-4 text-sm text-fg hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 sm:min-h-10"
      >
        {stillPending ? "Skip" : "Next"}
      </button>
    ),
  };
}

function ProgressBar({ position, total }: { position: number; total: number }) {
  const pct = total === 0 ? 100 : Math.min(100, Math.round((position / total) * 100));
  return (
    <div aria-hidden="true" className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fg/10">
      <div className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  );
}

const ENTRY_TEXT: Readonly<Record<RunEntryResult, { text: string; tone: string }>> = {
  accepted: { text: "Accepted", tone: "text-emerald-300" },
  changes: { text: "Changes requested", tone: "text-amber-200" },
  skipped: { text: "Skipped", tone: "text-fg" },
  left: { text: "Not reached", tone: "text-fg-muted" },
  elsewhere: { text: "Decided elsewhere", tone: "text-fg-muted" },
};

function RunSummary({ titleId, run, live, onReviewLeft, onClose }: { titleId: string; run: ReviewRun<QueueReview>; live: readonly QueueReview[]; onReviewLeft: () => void; onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tallies = runTallies(run);
  const reviewed = run.results.size;
  const left = leftPending(run, live);
  const onlySkipped = left.every((r) => run.results.get(r.id) === "skipped");
  const log = runLog(run, live);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const heading = left.length > 0 ? `${left.length} left for later` : reviewed === 0 ? "Nothing left to review" : "You're through the queue";
  const sub = reviewed === 0 && left.length === 0 ? "Every review in this run was decided elsewhere." : `${reviewed} review${reviewed === 1 ? "" : "s"} answered in this run.`;

  return (
    <section className="flex min-h-0 flex-1 flex-col items-center gap-8 overflow-y-auto p-6 text-center">
      <div className="mt-auto">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-fg focus:outline-none">
          {heading}
        </h2>
        <p className="mt-2 text-sm text-fg-muted">{sub}</p>
      </div>
      <dl className="grid w-full max-w-lg grid-cols-3 gap-3">
        <Tally label="Accepted" value={tallies.accepted} tone="text-emerald-300" />
        <Tally label="Changes requested" value={tallies.changes} tone="text-amber-200" />
        <Tally label="Skipped" value={tallies.skipped} tone="text-fg" />
      </dl>
      {log.length > 0 && (
        <ol aria-label="This run's reviews" className="w-full max-w-lg divide-y divide-hairline rounded-xl border border-hairline text-left text-sm">
          {log.map(({ item, result }) => (
            <li key={item.id} className="flex items-baseline gap-3 px-3 py-2">
              <span className="shrink-0 font-mono text-xs text-fg-muted">{item.externalId}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{item.title.trim() || "(untitled)"}</span>
              <span className={`shrink-0 text-xs ${ENTRY_TEXT[result].tone}`}>{ENTRY_TEXT[result].text}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="mb-auto flex flex-wrap items-center justify-center gap-3">
        {left.length > 0 && (
          <button
            type="button"
            onClick={onReviewLeft}
            className="min-h-11 rounded-lg border border-hairline px-4 text-sm text-fg hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {onlySkipped ? "Review skipped" : "Review the rest"} ({left.length})
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-lg bg-accent px-5 text-sm font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground"
        >
          Close
        </button>
      </div>
    </section>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-fg/[0.03] px-3 py-4">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className={`mt-1 text-3xl font-semibold tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}
