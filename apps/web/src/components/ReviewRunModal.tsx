// The review-all run-through (review-queue, design.md decision 6): a modal
// dialog over the current view that walks the queue one review at a time,
// in the spirit of a store's discovery queue. ReviewQueueProvider mounts it
// when the popover's "Review all" is pressed and unmounts it to end the
// run; the view and its address never change.
//
// A native <dialog> opened with showModal(), as the Lightbox is: the
// browser puts it in the top layer, makes the rest of the page inert, keeps
// Tab inside it, and fires `cancel` on Escape — and undoes all of it when
// the dialog closes or unmounts. Escape ends the run, except inside the
// review panel when it holds a draft or a decision is being written (the
// panel takes the key, so the dialog never sees a cancel); Close always
// ends it. A dialog the browser closes on its own also ends the run, so
// state and screen never disagree. The provider returns focus to the pill.
//
// The run (lib/reviewRun.ts) is the queue's order when opened; reviews
// that join the live queue meanwhile join its end. The header shows
// "n of m" and a progress bar; the body is ReviewItemPanel for the review
// on screen, keyed on it, so each review mounts fresh and its title takes
// focus. The panel's decisions read "Accept & next" and "Request changes &
// next" (a message is required, as in the drawer), and the run moves on
// only when the panel reports the decision written (`ok`): a failure or a
// partial write stays on the review with the panel's own messages. "Skip"
// moves on without writing; it reads "Next" (and tallies nothing) once the
// review on screen has left the live queue — decided elsewhere. Drafts go
// through the shell's shared map, so a message typed here is the one the
// drawer shows for the same review, and back.
//
// Keyboard: Ctrl/Cmd+Enter is "Accept & next", Ctrl/Cmd+Shift+Enter
// "Request changes & next" (the panel's shortcuts; no plain key is ever
// taken, so typing in the message box is never intercepted).
//
// The end is a summary — accepted, sent back, skipped — with "Close" and,
// when any skipped review is still pending, "Review skipped", which starts
// a new run over those. No state is stored; closing ends the run.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import type { ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { answerRun, currentPending, currentReview, runProgress, runTallies, skippedPending, startRun, syncRun, type ReviewRun, type RunResult } from "../lib/reviewRun.js";
import { storeDraft } from "./ReviewQueue.js";
import { ReviewItemPanel, type PanelDecisions } from "./ReviewItemPanel.js";

type QueueReview = ReviewQueueState["reviews"][number];

export interface ReviewRunModalProps {
  queue: ReviewQueueState;
  /** The shell's shared draft map, by bead id. */
  drafts: Map<string, string>;
  /** End the run (Close, Escape, or the browser closing the dialog). */
  onEnd: () => void;
}

const RESULT_TEXT: Readonly<Record<RunResult, string>> = {
  accepted: "Accepted",
  changes: "Changes requested on",
  skipped: "Skipped",
};

export function ReviewRunModal({ queue, drafts, onEnd }: ReviewRunModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const progressId = useId();
  const titleId = useId();
  const [run, setRun] = useState<ReviewRun<QueueReview>>(() => startRun(queue.reviews));
  const [last, setLast] = useState<{ result: RunResult; externalId: string } | null>(null);
  const live = useRef(queue.reviews);
  live.current = queue.reviews;

  // Before paint, so the dialog never shows un-modal for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    setRun((r) => syncRun(r, queue.reviews));
  }, [queue.reviews]);

  function answer(review: QueueReview, result: RunResult | null) {
    setRun((r) => answerRun(r, live.current, review.id, result));
    setLast(result === null ? null : { result, externalId: review.externalId });
  }

  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onEnd();
  }

  // Only a dialog still closed ends the run: StrictMode's remount closes and
  // reopens it, and that close event arrives after it is open again.
  function onClosed(e: SyntheticEvent<HTMLDialogElement>) {
    if (!e.currentTarget.open) onEnd();
  }

  function reviewSkipped() {
    setRun(startRun(skippedPending(run, live.current)));
    setLast(null);
  }

  const review = currentReview(run);
  const progress = runProgress(run, queue.reviews);
  const stillPending = currentPending(run, queue.reviews);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={review !== null ? `${progressId} ${titleId}` : titleId}
      onCancel={onCancel}
      onClose={onClosed}
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-surface-strong p-0 text-fg backdrop-blur-xl backdrop:bg-black/70 open:flex sm:m-auto sm:h-[min(58rem,calc(100dvh-3rem))] sm:w-[min(68rem,calc(100vw-3rem))] sm:rounded-2xl sm:border sm:border-hairline sm:shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]"
    >
      <header className="flex items-center gap-4 border-b border-hairline px-4 py-3 sm:px-5">
        <div className="shrink-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Review all</p>
          <p id={progressId} className="text-lg font-semibold tabular-nums leading-tight text-fg">
            {review !== null ? (
              <>
                {progress.position} <span className="font-normal text-fg-muted">of</span> {progress.total}
              </>
            ) : (
              "Done"
            )}
          </p>
        </div>
        <ProgressBar position={review !== null ? progress.position - 1 : progress.total} total={progress.total} />
        <p role="status" className="hidden min-w-0 max-w-[16rem] truncate text-xs text-fg-muted sm:block">
          {last !== null && review !== null && (
            <>
              {RESULT_TEXT[last.result]} <span className="font-mono">{last.externalId}</span>
            </>
          )}
        </p>
        <button
          type="button"
          aria-label="Close review all"
          onClick={onEnd}
          className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent sm:size-9"
        >
          ✕
        </button>
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
          onDecided={() => {}}
          onProjectConfirmed={() => {}}
          onEscape={onEnd}
          titleId={titleId}
          decisions={runDecisions(review, stillPending, answer)}
        />
      ) : (
        <RunSummary titleId={titleId} run={run} skipped={skippedPending(run, queue.reviews).length} onReviewSkipped={reviewSkipped} onClose={onEnd} />
      )}
    </dialog>
  );
}

function runDecisions(review: QueueReview, stillPending: boolean, answer: (review: QueueReview, result: RunResult | null) => void): PanelDecisions {
  return {
    acceptLabel: "Accept & next",
    changesLabel: "Request changes & next",
    shortcuts: true,
    onWritten: (decision: ReviewDecisionKind) => answer(review, decision === "accept" ? "accepted" : "changes"),
    extra: (
      <>
        <button
          type="button"
          onClick={() => answer(review, stillPending ? "skipped" : null)}
          className="min-h-11 rounded-lg border border-hairline px-4 text-sm text-fg hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-10"
        >
          {stillPending ? "Skip" : "Next"}
        </button>
        <span aria-hidden="true" className="hidden items-center gap-1 text-[11px] text-fg-muted lg:inline-flex">
          <Kbd>Ctrl/⌘</Kbd>
          <Kbd>Enter</Kbd> accept · add <Kbd>Shift</Kbd> for changes
        </span>
      </>
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

function RunSummary({ titleId, run, skipped, onReviewSkipped, onClose }: { titleId: string; run: ReviewRun<QueueReview>; skipped: number; onReviewSkipped: () => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const tallies = runTallies(run);
  const reviewed = run.results.size;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto p-6 text-center">
      <div>
        <h2 id={titleId} className="text-2xl font-semibold text-fg">
          {reviewed === 0 ? "Nothing left to review" : "You're through the queue"}
        </h2>
        <p className="mt-2 text-sm text-fg-muted">{reviewed === 0 ? "Every review in this run was decided elsewhere." : `${reviewed} review${reviewed === 1 ? "" : "s"} in this run.`}</p>
      </div>
      <dl role="status" className="grid w-full max-w-lg grid-cols-3 gap-3">
        <Tally label="Accepted" value={tallies.accepted} tone="text-emerald-300" />
        <Tally label="Sent back" value={tallies.changes} tone="text-amber-200" />
        <Tally label="Skipped" value={tallies.skipped} tone="text-fg" />
      </dl>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {skipped > 0 && (
          <button
            type="button"
            onClick={onReviewSkipped}
            className="min-h-11 rounded-lg border border-hairline px-4 text-sm text-fg hover:bg-fg/5 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Review skipped ({skipped})
          </button>
        )}
        <button
          ref={closeRef}
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

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-b-2 border-hairline px-1 font-mono text-[10px] text-fg">{children}</kbd>;
}
