// One board item, read and decided (review-queue, design.md decision 6):
// the body the board's drawer (ReviewDrawer.tsx) and the review-all modal
// (ReviewRunModal.tsx) both render, so there is one read path and one
// decision path. The host draws the frame around it and names it by
// `titleId`; the panel draws the header (id, parent, title, chips, graph
// link unless the host hides it, and the host's `headerEnd`), the body, and
// the pinned decision footer. The title takes focus on mount.
//
// Escape inside the panel goes to the host's `onEscape`, unless a draft is
// in the message box or a decision is being written (the state is checked,
// not the focused element); in both cases the panel takes the key
// (preventDefault), so a native dialog around it does not cancel on it too.
// An open attachment overlay (the lightbox) is a dialog of its own that
// stops Escape's propagation, so the panel never sees that key; the overlay
// flag only guards the shortcuts and the focus fix below.
//
// It reads one item (`boardItem`) by project and external id, and re-reads
// whenever the host's source re-reads (`boardVersion`) or a decision lands,
// keeping the previous answer on screen meanwhile. `{ item: null }` is the
// waiting state: the address can name a bead before its tracker has
// loaded, and the next change re-reads it.
//
// For a review filed as a decision card (decision-card-reviews, design.md
// decision 7, layout A; the card is core's `reviewCard`, served by
// `boardItem`): the question, the options with the recommended one first,
// the on-accept steps, the attachments (ReviewAttachments.tsx: one slot
// keyed by kind, before/after pairs ahead of the kinds), the evidence
// (collapsed when the card has options), and the thread (ReviewCardBody.tsx).
// A legacy review — no card keys — shows as it always has: its whole
// summary, its screenshots, its thread. A review the tracker holds
// malformed says it could not be read and keeps the plain decisions. While
// the review is open a pinned footer takes the decision with a message
// (`reviewDecision`): for a card with options, "Accept <recommended label>",
// one "Choose <label>" per other option (more than two fold behind one
// "Choose another…" disclosure), and "Request changes"; any other review
// keeps Accept / Request changes. Accepting an option sends its id and
// `seen` — the question and the option's text as shown (lib/reviewCard.ts
// `seenFor`) — so the server refuses it if the card changed underneath.
// A success is a status line; a failure is an alert box. A failure keeps
// the message unless the comment already landed (deciding again would post
// it twice). A thrown call is read by `describeThrownDecision`: a 4xx
// refusal is final and shown in the server's words (an option the card no
// longer offers, or a card that changed since it was opened: "reopen it"),
// anything else is uncertain — it says so, shows the raw error small, and
// re-reads the item so the thread shows what landed. Focus moves to
// whichever line reports the outcome, and to that line while a write is in
// flight (so focus never falls out of the panel when the pressed button
// disables).
// For any other item: its fields, its description, and a link to the
// graph.
//
// `layout` is the attachments' (ReviewAttachments.tsx): `column` stacks
// everything in one scrolling body; `stage` gives a review with
// attachments a two-column body — the attachments' stage on the left (two
// thirds), the card (or a legacy review's summary), evidence, thread, and
// the decision footer on the right.
//
// `decisions` lets a host relabel the two decisions (with short labels for
// phone widths, which also puts the three actions on one row there), hear
// when one reports written (`ok` — the run-through moves on then, and only
// then — with whether the agent could be told), add its own controls to
// the decision row (shown even when the item takes no decision, so the run
// can always move on, and told when a write is in flight), put a notice in
// place of the decision form (the run's "decided elsewhere"), append its
// suffix to a card's option actions (the run's "& next"), and turn on the
// keyboard shortcuts: Ctrl/Cmd+Enter accepts — on a card with options, the
// option whose button has focus, else the recommended one (the hint names
// its id; nothing on a card that recommends none, or from the fold's
// toggle), plain Accept otherwise — and Ctrl/Cmd+Shift+Enter requests
// changes (with no message it focuses the box and says one is needed).
// Choosing another option has no shortcut of its own: going against the
// recommendation is deliberate, so it takes reaching its button. No plain key is ever taken, so typing in
// the message box is never intercepted, and no key is taken from inside a
// dialog the panel opened (a lightbox, an enlarged diagram). `armAfterMs`
// keeps a decision from landing on an item before it has been seen: the
// buttons ignore presses for that long after mount, and the shortcuts
// ignore key repeat and wait for a fresh press since mount (see useArmed)
// — so a held or double Cmd+Enter, or a double click, decides one review,
// not the next. Without `decisions` the panel is the drawer's: "Accept",
// "Request changes", nothing extra, no shortcuts, no arming.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../lib/navigate.js";
import { reviewAttachments } from "../lib/reviewAttachments.js";
import { CARD_MOVED_TEXT, cardActions, chosenOption, describeChosen, isCardMovedRefusal, seenFor, type CardOption, type ChosenOption } from "../lib/reviewCard.js";
import { canDecide, decisionBlocked, decisionEffects, describeNotified, describeRecipient, describeThrownDecision, type ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { HttpStatusError, trpc } from "../trpc.js";
import { ReviewAttachments, SectionTitle, type AttachmentLayout, type AttachmentSlot } from "./ReviewAttachments.js";
import { ReviewSessionLinks } from "./ReviewSessionLinks.js";
import { cardShortcut, DecisionCardBody, DecisionFooter, type CardOutcome, type FooterLabels, type Refusal } from "./DecisionCard.js";

type BoardItem = NonNullable<Awaited<ReturnType<typeof trpc.boardItem.query>>["item"]>;

/** What the host hears with a written decision. */
export interface WrittenReport {
  /** "Agent notified (pane …)" or "Agent not notified: …"; null when the server does not say. */
  notified: string | null;
  /** The review promised a notice to a recorded pane and it could not be sent. */
  notifyFailed: boolean;
  /** The card option an accept named, and whether it was the recommendation; null for any other decision. */
  option: ChosenOption | null;
}

/** The footer's labels and host hooks (DecisionCard.tsx `FooterLabels`), plus what only the panel reads. */
export interface PanelDecisions extends FooterLabels {
  /** The decision reported written (`ok`). */
  onWritten?: (decision: ReviewDecisionKind, report: WrittenReport) => void;
  /** Ignore decisions for this long after mount (and shortcuts until a key is released since). */
  armAfterMs?: number;
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
  /** A decision wrote something (possibly in part, or possibly at all). */
  onDecided: () => void;
  /** `boardItem` found the item in `project`. */
  onProjectConfirmed: (project: string) => void;
  /** Escape with nothing in its way (see the header). */
  onEscape: () => void;
  /** A decision started or finished being written. */
  onBusyChange?: (busy: boolean) => void;
  /** The id the host's frame is labelled by; it goes on the panel's title. */
  titleId: string;
  /** At the end of the header row (the drawer's Close). */
  headerEnd?: ReactNode;
  /** "Open in graph" in the header; the run-through hides it (it would leave the run). */
  showGraphLink?: boolean;
  /**
   * The header on one row — id, title (truncated, the full text in its
   * tooltip), chips — so the card keeps the height (the run-through, where
   * the recommendation must stay above the fold beside a full footer).
   */
  compactHeader?: boolean;
  layout?: AttachmentLayout;
  decisions?: PanelDecisions;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** The HTTP status of a thrown tRPC call: the server's error shape, else a non-JSON response's (trpc.ts `HttpStatusError`); null for no response. */
function httpStatusOf(err: unknown): number | null {
  const e = err as { data?: { httpStatus?: unknown } | null; cause?: unknown } | null;
  const fromData = e?.data?.httpStatus;
  if (typeof fromData === "number") return fromData;
  return e?.cause instanceof HttpStatusError ? e.cause.status : null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Decisions are ignored until `ms` after mount. Shortcuts also wait for a
 * fresh press since mount — a key released, a pointer pressed, or a
 * Control/Meta newly pressed — so a chord still held from the previous
 * review (whose repeats the handler drops anyway) never decides this one,
 * while a person who clicked "Skip" and then presses Cmd+Enter is not
 * made to press it twice. A ref, read by the key handler of the very next
 * event.
 */
function useArmed(ms: number | undefined): { timeArmed: boolean; keyArmed: { current: boolean } } {
  const [timeArmed, setTimeArmed] = useState(ms === undefined);
  const keyArmed = useRef(ms === undefined);
  useEffect(() => {
    if (ms === undefined) return;
    const timer = setTimeout(() => setTimeArmed(true), ms);
    const arm = () => {
      keyArmed.current = true;
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!e.repeat && (e.key === "Control" || e.key === "Meta")) arm();
    };
    window.addEventListener("keyup", arm, true);
    window.addEventListener("pointerdown", arm, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keyup", arm, true);
      window.removeEventListener("pointerdown", arm, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [ms]);
  return { timeArmed, keyArmed };
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
  onBusyChange,
  titleId,
  headerEnd,
  showGraphLink = true,
  compactHeader = false,
  layout = "column",
  decisions = DRAWER_DECISIONS,
}: ReviewItemPanelProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [answer, setAnswer] = useState<BoardItem | null | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [overlays, setOverlays] = useState<ReadonlySet<AttachmentSlot>>(new Set());
  const [message, setMessageState] = useState(initialDraft);
  const [pending, setPending] = useState<ReviewDecisionKind | null>(null);
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CardOutcome | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [needsMessage, setNeedsMessage] = useState(false);
  /** The option whose decision button has focus: its text is shown in full in the list (ReviewCardBody.tsx). */
  const [focusedOption, setFocusedOption] = useState<string | null>(null);
  const optionIdPrefix = useId();
  const optionDescId = (id: string) => `${optionIdPrefix}-option-${id}`;
  const { timeArmed, keyArmed } = useArmed(decisions.armAfterMs);

  function setMessage(next: string) {
    setMessageState(next);
    onDraftChange(next);
    if (next.trim() !== "") setNeedsMessage(false);
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
  const overlayOpen = overlays.size > 0;

  // A re-read can take away the attachments altogether (the item is no
  // longer a review, or is gone), unmounting an open overlay with them: put
  // focus on the title. A renderer handles a list that merely got shorter.
  const reviewShown = loaded?.isReview === true;
  useEffect(() => {
    if (!overlayOpen || reviewShown) return;
    setOverlays(new Set());
    titleRef.current?.focus();
  }, [overlayOpen, reviewShown]);

  function onOverlayChange(slot: AttachmentSlot, open: boolean) {
    setOverlays((prev) => {
      if (prev.has(slot) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(slot);
      else next.delete(slot);
      return next;
    });
  }

  const decidable = loaded !== null && canDecide(loaded) && decisions.notice === undefined;
  const card = loaded?.isReview ? loaded.card : null;
  const actions = card !== null ? cardActions(card) : null;

  /** A key from inside a dialog the panel itself opened (a lightbox, an enlarged diagram) — not the host's dialog around the panel. */
  function fromOwnDialog(target: EventTarget): boolean {
    const dialog = target instanceof Element ? target.closest("dialog") : null;
    return dialog !== null && rootRef.current?.contains(dialog) === true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || overlayOpen || fromOwnDialog(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (message.trim() !== "" || pending !== null) return;
      onEscape();
    } else if (decisions.shortcuts) {
      const shortcut = cardShortcut(e, card, message);
      if (shortcut === null) return;
      e.preventDefault();
      if (e.repeat || !timeArmed || !keyArmed.current || !decidable) return;
      if (shortcut.kind === "needs-message") {
        setNeedsMessage(true);
        messageRef.current?.focus();
      } else if (shortcut.kind === "changes") {
        void decide("changes");
      } else if (shortcut.kind === "accept") {
        void decide("accept", shortcut.option);
      }
    }
  }

  /** `option` (an accept on a card with options) is sent with what the person saw of it. */
  async function decide(decision: ReviewDecisionKind, option?: CardOption) {
    if (!timeArmed || project === null || loaded === null || decisionBlocked(decision, message, pending !== null)) return;
    const chosen = option !== undefined && card !== null ? { option: option.id, seen: seenFor(card, option) } : {};
    const named = option !== undefined && card !== null ? chosenOption(card, option) : null;
    setPending(decision);
    setPendingOption(option?.id ?? null);
    onBusyChange?.(true);
    setOutcome(null);
    setRefusal(null);
    let written: { decision: ReviewDecisionKind; report: WrittenReport } | null = null;
    try {
      const result = await trpc.reviewDecision.mutate({ project, item: loaded.externalId, decision, message, ...chosen });
      const effects = decisionEffects(result, named === null ? undefined : describeChosen(named));
      const notified = describeNotified(result.notified);
      setOutcome({ ...effects.outcome, notified });
      if (effects.clearMessage) setMessage("");
      if (effects.reread) {
        setRefetch((n) => n + 1);
        onDecided();
      }
      // A failed notice matters only where one was promised (a pane and a herdr session recorded); otherwise the recipient line already said the comment is the record.
      const promised = loaded.review !== null && !("invalid" in loaded.review) && loaded.review.pane !== null && loaded.review.socket !== undefined;
      if (effects.written) written = { decision, report: { notified, notifyFailed: promised && result.notified?.ok === false, option: named } };
    } catch (err) {
      const thrown = describeThrownDecision({ message: messageOf(err, "The decision was refused."), httpStatus: httpStatusOf(err) });
      // The card is not the one the person read: show the current one now
      // (nothing was written, so the host is not told), and say so; the
      // typed message stays.
      const moved = !thrown.uncertain && isCardMovedRefusal(thrown.text);
      setRefusal(moved ? { text: CARD_MOVED_TEXT, detail: thrown.text } : { text: thrown.text, detail: thrown.detail });
      if (moved) setRefetch((n) => n + 1);
      if (thrown.uncertain) {
        setRefetch((n) => n + 1);
        onDecided();
      }
    } finally {
      setPending(null);
      setPendingOption(null);
      onBusyChange?.(false);
    }
    if (written !== null) decisions.onWritten?.(written.decision, written.report);
  }

  // What the panel can show: the item, still loading, or waiting for a tracker to bring it in.
  const waiting = project === null ? boardLoaded : answer === null;
  const title = loaded ? loaded.title || "(untitled)" : waiting ? `Waiting for ${item}` : readError ? item : "Loading…";
  const reviewFooter = loaded !== null && loaded.isReview && (decidable || outcome !== null || refusal !== null || decisions.notice !== undefined);
  const attachments = loaded?.isReview ? reviewAttachments(loaded) : [];
  const staged = layout === "stage" && attachments.length > 0;

  const attachmentSlot = (slotLayout: AttachmentLayout) => <ReviewAttachments attachments={attachments} layout={slotLayout} focusTitle={() => titleRef.current?.focus()} onOverlayChange={onOverlayChange} />;

  const body = (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      {readError && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {readError}
        </p>
      )}
      {!loaded && waiting && <p className="text-sm text-fg-muted">Waiting for {item}; it opens when its tracker loads.</p>}
      {loaded &&
        (loaded.isReview ? (
          <ReviewBody item={loaded} attachments={staged ? null : attachmentSlot("column")} focusedOption={focusedOption} optionDescId={optionDescId} />
        ) : (
          <PlainBody item={loaded} />
        ))}
    </div>
  );

  const footer = (reviewFooter || decisions.extra !== undefined) && (
    <DecisionFooter
      open={decidable}
      recipient={loaded?.isReview ? describeRecipient(loaded.review) : ""}
      sessionLinks={
        loaded?.isReview && project !== null && loaded.review !== null && !("invalid" in loaded.review) ? (
          <ReviewSessionLinks project={project} item={loaded.externalId} hasRequester={loaded.review.pane !== null && loaded.review.socket !== undefined} />
        ) : null
      }
      labels={decisions}
      actions={actions}
      message={message}
      setMessage={setMessage}
      messageRef={messageRef}
      needsMessage={needsMessage}
      pending={pending}
      pendingOption={pendingOption}
      onOptionFocus={setFocusedOption}
      optionDescId={optionDescId}
      outcome={outcome}
      refusal={refusal}
      decide={(d, option) => void decide(d, option)}
    />
  );

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      {compactHeader ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-4 py-2.5 sm:flex-nowrap">
          <span className="shrink-0 font-mono text-[11px] text-fg-muted">{loaded?.externalId ?? item}</span>
          <h2 id={titleId} ref={titleRef} tabIndex={-1} data-panel-title="" title={title} className="min-w-0 flex-1 truncate text-base font-semibold leading-snug text-fg focus:outline-none">
            {title}
          </h2>
          {loaded && (
            <div className="flex shrink-0 gap-1.5">
              {loaded.parent && (
                <span className="self-center whitespace-nowrap text-[11px] text-fg-muted">
                  child of <span className="font-mono">{loaded.parent.externalId}</span>
                </span>
              )}
              <Chip tone={statusTone(loaded.status)}>{loaded.status}</Chip>
              {loaded.isReview && <Chip tone="accent">review</Chip>}
              {loaded.labels.includes("review:changes") && <Chip tone="amber">review:changes</Chip>}
              <Chip>{loaded.project}</Chip>
            </div>
          )}
          {loaded && showGraphLink && <GraphLink nodeId={loaded.id} className="shrink-0 whitespace-nowrap rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent" />}
          {headerEnd}
        </div>
      ) : (
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
              <h2 id={titleId} ref={titleRef} tabIndex={-1} data-panel-title="" className="mt-1 text-base font-semibold leading-snug text-fg focus:outline-none">
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
            {loaded && showGraphLink && <GraphLink nodeId={loaded.id} className="mt-1 shrink-0 whitespace-nowrap rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent" />}
            {headerEnd}
          </div>
        </div>
      )}

      {staged ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-[2] border-r border-hairline p-4">{attachmentSlot("stage")}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {body}
            {footer}
          </div>
        </div>
      ) : (
        <>
          {body}
          {footer}
        </>
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

/**
 * A review's body; `attachments` is the slot when it sits in the body, null
 * when it is on the stage. A card in spec order (question, options,
 * on-accept, attachments, evidence); a legacy review as before (summary,
 * screenshots); then the thread.
 */
function ReviewBody({
  item,
  attachments,
  focusedOption,
  optionDescId,
}: {
  item: BoardItem;
  attachments: ReactNode;
  focusedOption: string | null;
  optionDescId: (id: string) => string;
}) {
  const review = item.review;
  const invalid = review !== null && "invalid" in review;
  const card = item.card !== null && !item.card.legacy ? item.card : null;
  return (
    <>
      {invalid && (
        <p role="note" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This review's details are malformed in the tracker, so its summary and screenshots cannot be shown. The thread and the decision still work.
        </p>
      )}
      {card !== null ? (
        <DecisionCardBody card={card} evidence={item.content} focusedOption={focusedOption} optionDescId={optionDescId}>
          {attachments}
        </DecisionCardBody>
      ) : (
        <>
          {review !== null && !("invalid" in review) && review.summary !== "" && (
            <section>
              <SectionTitle>Summary</SectionTitle>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{review.summary}</p>
            </section>
          )}
          {attachments}
        </>
      )}
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
