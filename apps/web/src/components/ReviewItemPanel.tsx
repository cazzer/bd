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
// keyboard shortcuts: Ctrl/Cmd+Enter accepts — the recommended option on a
// card with options (the hint names its id; nothing on a card that
// recommends none), plain Accept otherwise — and Ctrl/Cmd+Shift+Enter
// requests changes (with no message it focuses the box and says one is
// needed). Choosing another option has no shortcut: going against the
// recommendation is deliberate. No plain key is ever taken, so typing in
// the message box is never intercepted, and no key is taken from inside a
// dialog the panel opened (a lightbox, an enlarged diagram). `armAfterMs`
// keeps a decision from landing on an item before it has been seen: the
// buttons ignore presses for that long after mount, and the shortcuts
// ignore key repeat and wait for a fresh press since mount (see useArmed)
// — so a held or double Cmd+Enter, or a double click, decides one review,
// not the next. Without `decisions` the panel is the drawer's: "Accept",
// "Request changes", nothing extra, no shortcuts, no arming.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { navigate } from "../lib/navigate.js";
import { reviewAttachments } from "../lib/reviewAttachments.js";
import { cardActions, evidenceMarkdown, isCardReview, seenFor, type CardActions, type CardOption } from "../lib/reviewCard.js";
import { canDecide, decisionBlocked, decisionEffects, describeNotified, describeRecipient, describeThrownDecision, type DecisionOutcome, type ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { HttpStatusError, trpc } from "../trpc.js";
import { ReviewAttachments, SectionTitle, type AttachmentLayout, type AttachmentSlot } from "./ReviewAttachments.js";
import { CardEvidence, CardOnAccept, CardOptions, CardQuestion, InlineText } from "./ReviewCardBody.js";

type BoardItem = NonNullable<Awaited<ReturnType<typeof trpc.boardItem.query>>["item"]>;

/** What the host hears with a written decision. */
export interface WrittenReport {
  /** "Agent notified (pane …)" or "Agent not notified: …"; null when the server does not say. */
  notified: string | null;
  /** The review promised a notice to a recorded pane and it could not be sent. */
  notifyFailed: boolean;
}

export interface PanelDecisions {
  acceptLabel: string;
  changesLabel: string;
  /** Below `sm`; given both, the actions share one row there and the recipient line is left out. */
  acceptShort?: string;
  changesShort?: string;
  /** After a card's option actions ("Accept <label>", "Choose <label>"), shown muted: the run's "& next". */
  optionSuffix?: string;
  /** The decision reported written (`ok`). */
  onWritten?: (decision: ReviewDecisionKind, report: WrittenReport) => void;
  /** The host's own controls at the end of the decision row. */
  extra?: (state: { busy: boolean }) => ReactNode;
  /** Shown in place of the message box and the decisions, at the same height. */
  notice?: ReactNode;
  /** Ctrl/Cmd+Enter accepts, Ctrl/Cmd+Shift+Enter requests changes. */
  shortcuts?: boolean;
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
  layout?: AttachmentLayout;
  decisions?: PanelDecisions;
}

interface Outcome extends DecisionOutcome {
  notified: string | null;
}

interface Refusal {
  text: string;
  detail: string | null;
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [needsMessage, setNeedsMessage] = useState(false);
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
    } else if (decisions.shortcuts && e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      if (e.repeat || !timeArmed || !keyArmed.current || !decidable) return;
      const decision: ReviewDecisionKind = e.shiftKey ? "changes" : "accept";
      if (decision === "changes" && message.trim() === "") {
        setNeedsMessage(true);
        messageRef.current?.focus();
        return;
      }
      if (decision === "changes" || actions === null) void decide(decision);
      else if (actions.accept !== null) void decide("accept", actions.accept);
    }
  }

  /** `option` (an accept on a card with options) is sent with what the person saw of it. */
  async function decide(decision: ReviewDecisionKind, option?: CardOption) {
    if (!timeArmed || project === null || loaded === null || decisionBlocked(decision, message, pending !== null)) return;
    const chosen = option !== undefined && card !== null ? { option: option.id, seen: seenFor(card, option) } : {};
    setPending(decision);
    setPendingOption(option?.id ?? null);
    onBusyChange?.(true);
    setOutcome(null);
    setRefusal(null);
    let written: { decision: ReviewDecisionKind; report: WrittenReport } | null = null;
    try {
      const result = await trpc.reviewDecision.mutate({ project, item: loaded.externalId, decision, message, ...chosen });
      const effects = decisionEffects(result, option?.id);
      const notified = describeNotified(result.notified);
      setOutcome({ ...effects.outcome, notified });
      if (effects.clearMessage) setMessage("");
      if (effects.reread) {
        setRefetch((n) => n + 1);
        onDecided();
      }
      // A failed notice matters only where one was promised (a pane and a herdr session recorded); otherwise the recipient line already said the comment is the record.
      const promised = loaded.review !== null && !("invalid" in loaded.review) && loaded.review.pane !== null && loaded.review.socket !== undefined;
      if (effects.written) written = { decision, report: { notified, notifyFailed: promised && result.notified?.ok === false } };
    } catch (err) {
      const thrown = describeThrownDecision({ message: messageOf(err, "The decision was refused."), httpStatus: httpStatusOf(err) });
      setRefusal({ text: thrown.text, detail: thrown.detail });
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
      {loaded && (loaded.isReview ? <ReviewBody item={loaded} attachments={staged ? null : attachmentSlot("column")} /> : <PlainBody item={loaded} />)}
    </div>
  );

  const footer = (reviewFooter || decisions.extra !== undefined) && (
    <DecisionFooter
      open={decidable}
      recipient={loaded?.isReview ? describeRecipient(loaded.review) : ""}
      labels={decisions}
      actions={actions}
      message={message}
      setMessage={setMessage}
      messageRef={messageRef}
      needsMessage={needsMessage}
      pending={pending}
      pendingOption={pendingOption}
      outcome={outcome}
      refusal={refusal}
      decide={(d, option) => void decide(d, option)}
    />
  );

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
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
function ReviewBody({ item, attachments }: { item: BoardItem; attachments: ReactNode }) {
  const review = item.review;
  const invalid = review !== null && "invalid" in review;
  const card = review !== null && !("invalid" in review) && isCardReview(review) ? item.card : null;
  const evidence = card !== null ? evidenceMarkdown(item.content, card.question) : null;
  return (
    <>
      {invalid && (
        <p role="note" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This review's details are malformed in the tracker, so its summary and screenshots cannot be shown. The thread and the decision still work.
        </p>
      )}
      {card !== null ? (
        <>
          <CardQuestion question={card.question} />
          <CardOptions card={card} />
          <CardOnAccept steps={card.onAccept} />
          {attachments}
          {evidence !== null && <CardEvidence markdown={evidence} collapsible={card.options.length > 0} />}
        </>
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

function DecisionFooter({
  open,
  recipient,
  labels,
  actions,
  message,
  setMessage,
  messageRef,
  needsMessage,
  pending,
  pendingOption,
  outcome,
  refusal,
  decide,
}: {
  open: boolean;
  /** Who the decision will be pushed to (describeRecipient). */
  recipient: string;
  labels: PanelDecisions;
  /** A card's option actions (lib/reviewCard.ts `cardActions`); null keeps plain Accept / Request changes. */
  actions: CardActions | null;
  message: string;
  setMessage: (m: string) => void;
  messageRef: RefObject<HTMLTextAreaElement | null>;
  needsMessage: boolean;
  pending: ReviewDecisionKind | null;
  /** The option being accepted while `pending` is "accept". */
  pendingOption: string | null;
  outcome: Outcome | null;
  refusal: Refusal | null;
  decide: (decision: ReviewDecisionKind, option?: CardOption) => void;
}) {
  const messageId = useId();
  const labelId = useId();
  const hintId = useId();
  const reportRef = useRef<HTMLDivElement>(null);
  const busy = pending !== null;
  const compact = labels.acceptShort !== undefined && labels.changesShort !== undefined;

  // Focus follows the outcome, so a keyboard or screen-reader user lands on
  // what happened — and sits on that line while the write is in flight, so
  // the pressed button disabling never drops focus out of the panel.
  useEffect(() => {
    if (busy || outcome !== null || refusal !== null) reportRef.current?.focus();
  }, [busy, outcome, refusal]);

  const failure: Refusal | null = refusal ?? (outcome !== null && outcome.tone !== "ok" ? { text: outcome.text, detail: null } : null);
  const textareaHeight = message !== "" ? "max-sm:h-[4.5rem]" : "max-sm:h-11 max-sm:focus:h-[4.5rem]";

  return (
    <div className="space-y-2 border-t border-hairline bg-surface-strong p-4">
      {labels.notice !== undefined && <div className="flex min-h-[5.25rem] items-center rounded-lg border border-hairline bg-fg/[0.03] px-3 py-2 text-sm text-fg">{labels.notice}</div>}
      {open && (
        <>
          <label id={labelId} htmlFor={messageId} className="block text-xs text-fg-muted">
            <span className="sm:hidden">Message to the agent (required for changes)</span>
            <span className="hidden sm:inline">Message to the agent — sent with either decision, required for Request changes</span>
          </label>
          <textarea
            id={messageId}
            ref={messageRef}
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            aria-describedby={needsMessage ? hintId : undefined}
            className={`block w-full resize-none rounded-lg border border-hairline bg-ground/60 px-3 py-2 text-base text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:text-sm ${textareaHeight}`}
          />
          {needsMessage && (
            <p id={hintId} role="alert" className="text-xs text-amber-200">
              Add a message to request changes.
            </p>
          )}
        </>
      )}
      {open && actions !== null && (
        <div className="space-y-1.5">
          {actions.accept !== null && (
            <OptionAction
              option={actions.accept}
              verb="Accept"
              primary
              suffix={labels.optionSuffix}
              pending={pending === "accept" && pendingOption === actions.accept.id}
              disabled={decisionBlocked("accept", message, busy)}
              keyshortcuts={labels.shortcuts ? "Control+Enter Meta+Enter" : undefined}
              onPress={() => decide("accept", actions.accept!)}
            />
          )}
          {actions.choices.map((o) => (
            <OptionAction key={o.id} option={o} verb="Choose" suffix={labels.optionSuffix} pending={pending === "accept" && pendingOption === o.id} disabled={decisionBlocked("accept", message, busy)} onPress={() => decide("accept", o)} />
          ))}
          {actions.folded.length > 0 && (
            <ChooseAnother
              options={actions.folded}
              suffix={labels.optionSuffix}
              pendingOption={pending === "accept" ? pendingOption : null}
              disabled={decisionBlocked("accept", message, busy)}
              onChoose={(o) => decide("accept", o)}
            />
          )}
        </div>
      )}
      {(open || labels.extra !== undefined) && (
        <div className={`flex items-center gap-2 ${compact ? "max-sm:flex-nowrap max-sm:[&>button]:flex-1 sm:flex-wrap" : "flex-wrap"}`}>
          {open && (
            <>
              {actions === null && (
                <button
                  type="button"
                  onClick={() => decide("accept")}
                  disabled={decisionBlocked("accept", message, busy)}
                  aria-keyshortcuts={labels.shortcuts ? "Control+Enter Meta+Enter" : undefined}
                  className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-60 sm:min-h-10"
                >
                  {pending === "accept" ? "Accepting…" : <Label full={labels.acceptLabel} short={labels.acceptShort} />}
                </button>
              )}
              <button
                type="button"
                onClick={() => decide("changes")}
                disabled={decisionBlocked("changes", message, busy)}
                aria-describedby={message.trim() === "" ? labelId : undefined}
                aria-keyshortcuts={labels.shortcuts ? "Control+Shift+Enter Meta+Shift+Enter" : undefined}
                className={`min-h-11 rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 text-sm font-medium text-amber-200 hover:bg-amber-400/20 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10 ${actions !== null ? "flex-1" : ""}`}
              >
                {pending === "changes" ? "Sending…" : <Label full={labels.changesLabel} short={labels.changesShort} />}
              </button>
            </>
          )}
          {labels.extra?.({ busy })}
        </div>
      )}
      {open && (
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted ${compact ? "max-sm:hidden" : ""}`}>
          <span>{recipient}</span>
          {labels.shortcuts && (
            <span aria-hidden="true" className="ml-auto hidden items-center gap-1 lg:inline-flex">
              {actions === null || actions.accept !== null ? (
                <>
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>Enter</Kbd> accept{actions?.accept ? <> {actions.accept.id}</> : null} · add <Kbd>Shift</Kbd> to request changes
                </>
              ) : (
                <>
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>Shift</Kbd>
                  <Kbd>Enter</Kbd> request changes
                </>
              )}
            </span>
          )}
        </div>
      )}
      <div ref={reportRef} tabIndex={-1} className="focus:outline-none">
        {failure !== null ? (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {failure.text}
            {failure.detail !== null && <span className="mt-1 block break-words font-mono text-xs text-fg-muted">{failure.detail}</span>}
            {refusal === null && outcome?.notified && <span className="mt-1 block text-fg-muted">{outcome.notified}</span>}
          </div>
        ) : (
          <p role="status" className="text-xs text-emerald-300">
            {busy && <span className="text-fg-muted">Writing the decision…</span>}
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

const OPTION_BUTTON_BASE = "flex min-h-11 w-full items-center gap-2 rounded-lg px-4 text-left text-sm focus:outline-none focus:ring-2 disabled:opacity-60 sm:min-h-10";
const OPTION_BUTTON_PRIMARY = `${OPTION_BUTTON_BASE} bg-accent font-semibold text-ground hover:bg-accent/90 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground`;
const OPTION_BUTTON_OTHER = `${OPTION_BUTTON_BASE} border border-accent/40 bg-accent/[0.06] font-medium text-fg hover:bg-accent/15 focus:ring-accent`;

/**
 * "Accept <label>" (primary) or "Choose <label>", the option id in a mono
 * prefix. The visible text starts the accessible name; the id follows it
 * there ("(option B)"), since the prefix is hidden from it.
 */
function OptionAction({
  option,
  verb,
  primary = false,
  suffix,
  pending,
  disabled,
  keyshortcuts,
  onPress,
  buttonRef,
  onKeyDown,
}: {
  option: CardOption;
  verb: "Accept" | "Choose";
  primary?: boolean;
  suffix: string | undefined;
  pending: boolean;
  disabled: boolean;
  keyshortcuts?: string;
  onPress: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button ref={buttonRef} type="button" onClick={onPress} onKeyDown={onKeyDown} disabled={disabled} aria-keyshortcuts={keyshortcuts} className={primary ? OPTION_BUTTON_PRIMARY : OPTION_BUTTON_OTHER}>
      {!primary && (
        <span aria-hidden="true" className="shrink-0 font-mono text-xs text-fg-muted">
          {option.id}
        </span>
      )}
      <span className="min-w-0 truncate">
        {pending ? (
          `Accepting ${option.id}…`
        ) : (
          <>
            {verb} <InlineText text={option.label} />
          </>
        )}
      </span>
      <span className="sr-only">
        {" "}
        (option {option.id}
        {primary ? ", recommended" : ""})
      </span>
      {suffix !== undefined && !pending && <span className={`ml-auto shrink-0 text-xs font-normal ${primary ? "text-ground/80" : "text-fg-muted"}`}>{suffix}</span>}
    </button>
  );
}

/**
 * More than two other options: one "Choose another…" disclosure button
 * that shows them as a list of Choose actions under it (keyboard: Tab, or
 * the arrow keys, Home and End between them; Escape closes the list and
 * returns to the button without leaving the panel or the run).
 */
function ChooseAnother({
  options,
  suffix,
  pendingOption,
  disabled,
  onChoose,
}: {
  options: readonly CardOption[];
  suffix: string | undefined;
  pendingOption: string | null;
  disabled: boolean;
  onChoose: (option: CardOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function onItemKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = options.length - 1;
    const target = e.key === "ArrowDown" ? (i === last ? 0 : i + 1) : e.key === "ArrowUp" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (target !== null) {
      e.preventDefault();
      itemRefs.current[target]?.focus();
    } else if (e.key === "Escape") {
      // Taken here (preventDefault), so neither the panel nor a dialog around it treats it as leaving.
      e.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  return (
    <div>
      <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)} className={OPTION_BUTTON_OTHER}>
        <span className="min-w-0 truncate">Choose another…</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-fg-muted">
          {options.map((o) => o.id).join(" · ")} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <ul id={listId} aria-label="Other options" className="mt-1.5 space-y-1.5 border-l-2 border-hairline pl-2">
          {options.map((o, i) => (
            <li key={o.id}>
              <OptionAction
                option={o}
                verb="Choose"
                suffix={suffix}
                pending={pendingOption === o.id}
                disabled={disabled}
                onPress={() => onChoose(o)}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                buttonRef={(el) => {
                  itemRefs.current[i] = el;
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Label({ full, short }: { full: string; short: string | undefined }) {
  if (short === undefined) return <>{full}</>;
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-b-2 border-hairline px-1 font-mono text-xs text-fg">{children}</kbd>;
}
