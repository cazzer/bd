// One board item, read and decided (review-queue, design.md decision 6):
// the body the board's drawer (ReviewDrawer.tsx) and the review-all modal
// (ReviewRunModal.tsx) both render, so there is one read path and one
// decision path. The host draws the frame around it and names it by
// `titleId`; the panel draws the header (id, parent, title, chips, graph
// link, and the host's `headerEnd`), the scrolling body, and the pinned
// decision footer. The title takes focus on mount. Escape inside the panel
// goes to the host's `onEscape`, unless a draft is in the message box or a
// decision is being written (the state is checked, not the focused
// element), or an attachment's overlay is open (the lightbox handles
// Escape); either way the panel takes the key (preventDefault), so a
// native dialog around it does not cancel on it too.
//
// It reads one item (`boardItem`) by project and external id, and re-reads
// whenever the host's source re-reads (`boardVersion`) or a decision lands,
// keeping the previous answer on screen meanwhile. `{ item: null }` is the
// waiting state: the address can name a bead before its tracker has
// loaded, and the next change re-reads it.
//
// For a review: summary, attachments (one slot keyed by kind,
// ReviewAttachments.tsx — screenshots today), the comment thread, and —
// while the review is open — a pinned footer taking Accept or Request
// changes with a message (`reviewDecision`). A success is a status line; a
// failure is an alert box. A failure keeps the message unless the comment
// already landed (deciding again would post it twice). Focus moves to
// whichever line reports the outcome. For any other item: its fields, its
// description, and a link to the graph.
//
// `decisions` lets a host relabel the two decisions, hear when one reports
// written (`ok` — the run-through moves on then, and only then), add its
// own controls to the decision row (shown even when the item takes no
// decision, so the run can always move on), and turn on the keyboard
// shortcuts: Ctrl/Cmd+Enter takes the first decision, Ctrl/Cmd+Shift+Enter
// the second. No plain key is ever taken, so typing in the message box is
// never intercepted. Without it the panel is the drawer's: "Accept",
// "Request changes", no extra controls, no shortcuts.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../lib/navigate.js";
import { reviewAttachments } from "../lib/reviewAttachments.js";
import { canDecide, decisionBlocked, describeDecision, describeNotified, describeRecipient, type DecisionOutcome, type ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { trpc } from "../trpc.js";
import { ReviewAttachments, SectionTitle } from "./ReviewAttachments.js";

type BoardItem = NonNullable<Awaited<ReturnType<typeof trpc.boardItem.query>>["item"]>;

export interface PanelDecisions {
  acceptLabel: string;
  changesLabel: string;
  /** The decision reported written (`ok`). */
  onWritten?: (decision: ReviewDecisionKind) => void;
  /** The host's own controls at the end of the decision row. */
  extra?: ReactNode;
  /** Ctrl/Cmd+Enter accepts, Ctrl/Cmd+Shift+Enter requests changes. */
  shortcuts?: boolean;
}

const DRAWER_DECISIONS: PanelDecisions = { acceptLabel: "Accept", changesLabel: "Request changes" };

export interface ReviewItemPanelProps {
  /** The item's project; null while it cannot be known yet (the panel waits). */
  project: string | null;
  /** The external id (a bead id). */
  item: string;
  /** False until the host's first read lands. */
  boardLoaded: boolean;
  /** Bumped by the host after every read of its source; the panel re-reads on it. */
  boardVersion: number;
  /** The draft kept for this item from an earlier opening. */
  initialDraft: string;
  onDraftChange: (draft: string) => void;
  /** A decision wrote something (possibly in part). */
  onDecided: () => void;
  /** `boardItem` found the item in `project`. */
  onProjectConfirmed: (project: string) => void;
  /** Escape with nothing in its way (see the header). */
  onEscape: () => void;
  /** The id the host's frame is labelled by; it goes on the panel's title. */
  titleId: string;
  /** At the end of the header row (the drawer's Close). */
  headerEnd?: ReactNode;
  decisions?: PanelDecisions;
}

interface Outcome extends DecisionOutcome {
  notified: string | null;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ReviewItemPanel({
  project,
  item,
  boardLoaded,
  boardVersion,
  initialDraft,
  onDraftChange,
  onDecided,
  onProjectConfirmed,
  onEscape,
  titleId,
  headerEnd,
  decisions = DRAWER_DECISIONS,
}: ReviewItemPanelProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [answer, setAnswer] = useState<BoardItem | null | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [message, setMessageState] = useState(initialDraft);
  const [pending, setPending] = useState<ReviewDecisionKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  function setMessage(next: string) {
    setMessageState(next);
    onDraftChange(next);
  }

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (project === null) return;
    let cancelled = false;
    trpc.boardItem
      .query({ project, item })
      .then((res) => {
        if (cancelled) return;
        setAnswer(res.item);
        setReadError(null);
        if (res.item !== null) onProjectConfirmed(project);
      })
      .catch((err: unknown) => {
        if (!cancelled) setReadError(messageOf(err, "Failed to read this item."));
      });
    return () => {
      cancelled = true;
    };
  }, [project, item, boardVersion, refetch]);

  const loaded = answer ?? null;

  // A re-read can take away the attachments altogether (the item is no
  // longer a review, or is gone), unmounting an open overlay with them: put
  // focus on the title. A renderer handles a list that merely got shorter.
  const reviewShown = loaded?.isReview === true;
  useEffect(() => {
    if (!overlayOpen || reviewShown) return;
    setOverlayOpen(false);
    titleRef.current?.focus();
  }, [overlayOpen, reviewShown]);

  const decidable = loaded !== null && canDecide(loaded);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || overlayOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (message.trim() !== "" || pending !== null) return;
      onEscape();
    } else if (decisions.shortcuts && e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && decidable) {
      e.preventDefault();
      void decide(e.shiftKey ? "changes" : "accept");
    }
  }

  async function decide(decision: ReviewDecisionKind) {
    if (project === null || loaded === null || decisionBlocked(decision, message, pending !== null)) return;
    setPending(decision);
    setOutcome(null);
    setRefusal(null);
    try {
      const result = await trpc.reviewDecision.mutate({ project, item: loaded.externalId, decision, message });
      const described = describeDecision(result);
      setOutcome({ ...described, notified: describeNotified(result.notified) });
      if (!described.keepMessage) setMessage("");
      if (result.written.length > 0 || result.uncertain !== undefined) {
        setRefetch((n) => n + 1);
        onDecided();
      }
      if (result.ok) decisions.onWritten?.(decision);
    } catch (err) {
      setRefusal(messageOf(err, "The decision was refused."));
    } finally {
      setPending(null);
    }
  }

  // What the panel can show: the item, still loading, or waiting for a tracker to bring it in.
  const waiting = project === null ? boardLoaded : answer === null;
  const title = loaded ? loaded.title || "(untitled)" : waiting ? `Waiting for ${item}` : readError ? item : "Loading…";
  const reviewFooter = loaded !== null && loaded.isReview && (decidable || outcome !== null || refusal !== null);

  return (
    <div onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-hairline p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-muted">
              <span className="font-mono">{loaded?.externalId ?? item}</span>
              {loaded?.parent && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    child of <span className="font-mono">{loaded.parent.externalId}</span>
                  </span>
                </>
              )}
            </div>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} className="mt-1 text-base font-semibold leading-snug text-fg focus:outline-none">
              {title}
            </h2>
            {loaded && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone={statusTone(loaded.status)}>{loaded.status}</Chip>
                {loaded.isReview && <Chip tone="accent">review</Chip>}
                {loaded.labels.includes("review:changes") && <Chip tone="amber">review:changes</Chip>}
                <Chip>{loaded.project}</Chip>
              </div>
            )}
          </div>
          {loaded && <GraphLink nodeId={loaded.id} className="mt-1 shrink-0 whitespace-nowrap rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent" />}
          {headerEnd}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {readError && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {readError}
          </p>
        )}
        {!loaded && waiting && <p className="text-sm text-fg-muted">Waiting for {item}; it opens when its tracker loads.</p>}
        {loaded &&
          (loaded.isReview ? (
            <ReviewBody item={loaded} onOverlayChange={setOverlayOpen} focusTitle={() => titleRef.current?.focus()} />
          ) : (
            <PlainBody item={loaded} />
          ))}
      </div>

      {(reviewFooter || decisions.extra !== undefined) && (
        <DecisionFooter
          open={decidable}
          recipient={loaded?.isReview ? describeRecipient(loaded.review) : ""}
          labels={decisions}
          message={message}
          setMessage={setMessage}
          pending={pending}
          outcome={outcome}
          refusal={refusal}
          decide={(d) => void decide(d)}
        />
      )}
    </div>
  );
}

function statusTone(status: string): ChipTone {
  switch (status) {
    case "closed":
    case "deferred":
      return "muted";
    case "blocked":
      return "red";
    case "in_progress":
      return "amber";
    default:
      return "green";
  }
}

type ChipTone = "muted" | "accent" | "green" | "amber" | "red";

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: ChipTone }) {
  const cls =
    tone === "accent"
      ? "border-accent/60 bg-accent/15 text-fg"
      : tone === "green"
        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
        : tone === "amber"
          ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
          : tone === "red"
            ? "border-red-500/40 bg-red-500/10 text-red-300"
            : "border-hairline text-fg-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

function GraphLink({ nodeId, className, children = "Open in graph" }: { nodeId: string; className: string; children?: ReactNode }) {
  const route: GraphRoute = { view: "graph", q: null, types: [], node: nodeId };
  function open(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(route, "push");
  }
  return (
    <a href={formatRoute(route)} onClick={open} className={className}>
      {children}
    </a>
  );
}

function ReviewBody({ item, onOverlayChange, focusTitle }: { item: BoardItem; onOverlayChange: (open: boolean) => void; focusTitle: () => void }) {
  const review = item.review;
  const invalid = review !== null && "invalid" in review;
  return (
    <>
      {invalid && (
        <p role="note" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This review's details are malformed in the tracker, so its summary and screenshots cannot be shown. The thread and the decision still work.
        </p>
      )}
      {review !== null && !("invalid" in review) && review.summary !== "" && (
        <section>
          <SectionTitle>Summary</SectionTitle>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{review.summary}</p>
        </section>
      )}
      <ReviewAttachments attachments={reviewAttachments(item)} focusTitle={focusTitle} onOverlayChange={onOverlayChange} />
      <Thread comments={item.comments} />
      {item.status === "closed" && (
        <p className="rounded-lg border border-hairline px-3 py-2 text-sm text-fg">
          Closed{item.closedReason ? <>: {item.closedReason}</> : "."}
        </p>
      )}
    </>
  );
}

function Thread({ comments }: { comments: BoardItem["comments"] }) {
  return (
    <section>
      <SectionTitle>Thread · {comments.length}</SectionTitle>
      {comments.length === 0 ? (
        <p className="text-sm text-fg-muted">No comments yet.</p>
      ) : (
        <ol className="space-y-2.5">
          {comments.map((c, i) => (
            <li key={`${i}:${c.id}`} className="rounded-lg border border-hairline bg-surface-strong px-3 py-2">
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-fg-muted">
                <span className="font-medium text-fg">{c.author ?? "unknown"}</span>
                {c.created_at && <time dateTime={c.created_at}>{formatTime(c.created_at)}</time>}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PlainBody({ item }: { item: BoardItem }) {
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-fg-muted">Status</dt>
        <dd className="text-fg">
          {item.status}
          {item.status === "closed" && item.closedReason && <span className="text-fg-muted"> ({item.closedReason})</span>}
        </dd>
        <dt className="text-fg-muted">Priority</dt>
        <dd className="text-fg">P{item.priority}</dd>
        <dt className="text-fg-muted">Type</dt>
        <dd className="text-fg">{item.issueType ?? "—"}</dd>
        <dt className="text-fg-muted">Assignee</dt>
        <dd className="break-words text-fg">{item.assignee ?? "—"}</dd>
      </dl>
      <section>
        <SectionTitle>Description</SectionTitle>
        {item.content.trim() === "" ? (
          <p className="text-sm text-fg-muted">No description.</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{item.content}</p>
        )}
      </section>
      <GraphLink nodeId={item.id} className="inline-block rounded-lg border border-hairline px-3 py-1.5 text-sm text-accent hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent">
        Open in graph →
      </GraphLink>
    </div>
  );
}

function DecisionFooter({
  open,
  recipient,
  labels,
  message,
  setMessage,
  pending,
  outcome,
  refusal,
  decide,
}: {
  open: boolean;
  /** Who the decision will be pushed to (describeRecipient). */
  recipient: string;
  labels: PanelDecisions;
  message: string;
  setMessage: (m: string) => void;
  pending: ReviewDecisionKind | null;
  outcome: Outcome | null;
  refusal: string | null;
  decide: (decision: ReviewDecisionKind) => void;
}) {
  const messageId = useId();
  const labelId = useId();
  const reportRef = useRef<HTMLDivElement>(null);
  const busy = pending !== null;

  // Focus follows the outcome, so a keyboard or screen-reader user lands on what happened.
  useEffect(() => {
    if (outcome !== null || refusal !== null) reportRef.current?.focus();
  }, [outcome, refusal]);

  const failure = refusal ?? (outcome !== null && outcome.tone !== "ok" ? outcome.text : null);

  return (
    <div className="space-y-2 border-t border-hairline bg-surface-strong p-4">
      {open && (
        <>
          <label id={labelId} htmlFor={messageId} className="block text-xs text-fg-muted">
            Message to the agent — sent with either decision, required for Request changes
          </label>
          <textarea
            id={messageId}
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            className="block w-full resize-none rounded-lg border border-hairline bg-ground/60 px-3 py-2 text-base text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:text-sm"
          />
        </>
      )}
      {(open || labels.extra !== undefined) && (
        <div className="flex flex-wrap items-center gap-2">
          {open && (
            <>
              <button
                type="button"
                onClick={() => decide("accept")}
                disabled={decisionBlocked("accept", message, busy)}
                aria-keyshortcuts={labels.shortcuts ? "Control+Enter Meta+Enter" : undefined}
                className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-60 sm:min-h-10"
              >
                {pending === "accept" ? "Accepting…" : labels.acceptLabel}
              </button>
              <button
                type="button"
                onClick={() => decide("changes")}
                disabled={decisionBlocked("changes", message, busy)}
                aria-describedby={message.trim() === "" ? labelId : undefined}
                aria-keyshortcuts={labels.shortcuts ? "Control+Shift+Enter Meta+Shift+Enter" : undefined}
                className="min-h-11 rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 text-sm font-medium text-amber-200 hover:bg-amber-400/20 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10"
              >
                {pending === "changes" ? "Sending…" : labels.changesLabel}
              </button>
            </>
          )}
          {labels.extra}
          {open && <span className="text-xs text-fg-muted">{recipient}</span>}
        </div>
      )}
      <div ref={reportRef} tabIndex={-1} className="focus:outline-none">
        {failure !== null ? (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {failure}
            {refusal === null && outcome?.notified && <span className="mt-1 block text-fg-muted">{outcome.notified}</span>}
          </div>
        ) : (
          <p role="status" className="text-xs text-emerald-300">
            {outcome && (
              <>
                {outcome.text}
                {outcome.notified && <span className="block text-fg-muted">{outcome.notified}</span>}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
