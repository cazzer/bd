// The review queue in the shell (review-queue, design.md decisions 3-4,
// prototype A): the queue state App.tsx reads once, outside its view
// switch, shared through `ReviewQueueContext`; the review control
// (`ReviewQueuePill`) the shell header draws, and which some views still
// place in their own headers until they adopt the shell's (shared-nav-header
// task group 3); the popover anchored under the pill that opened it; and the
// drawer a pick opens over the current view.
//
// Two contexts, so a queue read re-renders only what shows the queue. The
// queue context (queue, live state, popover actions) is read by the pills
// alone. `ShellDrawerContext` carries whether the shell's drawer is open —
// which views read to pad themselves clear of it, as the board already does
// for its own — and the one draft map both drawers share, keyed by bead id,
// so a message typed in either survives a switch to the other.
//
// Pill (the review control, shared-nav-header design.md decision 6). A
// button holding the status light (filled green = live, half amber =
// connecting, red ring = offline — shape as well as colour), the word for
// that state (wide and from `sm` up only; elsewhere the light's shape and
// the accessible name carry it), the pending review count, and — when the
// header passes one greater than 0 — the inbox count beside a tray icon.
// The counts are the queue's reviews and the inbox items of Needs me that
// are not reviews (lib/inboxRows.ts `needsMeItem`), so nothing is counted
// twice. Its accessible name is built from sr-only text, one piece per
// count ("Live, 2 reviews pending, 3 inbox items need you",
// lib/reviewQueueRow.ts `pillLabel`, also its tooltip); the visible numbers
// are hidden from assistive technology. Compact (the header's tighter
// tiers) drops the word and the divider and shows bare numbers. The state
// word sits in a box wide enough for "Connecting…", so a flip never shifts
// the header. A null inbox count (not read yet, or the read failed) shows
// no inbox count, and the pill works as before. Every pill registers with
// the provider; ArrowDown on a pill opens the popover under it, or focuses
// its active row when it is already open there; Escape closes it.
//
// Announcements. One polite status region (here, not per pill, so a view
// change says nothing). It speaks a change of the count after the first
// read, and a lasting change of the stream between live and offline (held
// LIVE_ANNOUNCE_HOLD_MS); never the first load, a reconnect, or connecting.
//
// Popover. Anchored under the pill that opened it — the one the reader
// activated, not whichever registered last, while it is in the document;
// else the first pill still registered (the header's, which outlives
// every view) — and focus returns to that same pill (portalled to <body> and positioned from
// the pill's rect, since the headers it sits in are `glass` — a
// backdrop-filter makes them the containing block of anything fixed inside
// them — and the code view's clips). It follows the pill every frame while
// open, since a pill can move with no resize or scroll (a header narrowing
// for a drawer). A non-modal dialog: rows oldest first, arrows / Home / End
// move between them (roving tabindex), Enter or a click picks, Escape closes
// it and returns focus to the pill, and a click or focus outside it closes
// it without moving focus. Being portalled, it sits at the end of the tab
// order, so Tab past its last control or Shift+Tab before its first closes
// it onto the pill, and the default Tab then moves on from there. It shows
// the order line ("Oldest first", or "Oldest 100 of 120" when truncated), a
// staleness line while the stream is not live, an empty state, and the
// queue's read error over the last answer. "Review all" (design.md decision
// 6) sits in its header, disabled while the queue is empty. Its footer
// links to the board (except on the board) and to the inbox's Needs me
// (except on the inbox): "Go to inbox" opens `/inbox` — Needs me is the
// inbox's first tab — with the projects of the pill that opened it (the
// header's links' projects), else the address's, and closes the popover.
//
// Drawer. A pick opens the board's ReviewDrawer from here (decision 4): the
// project from the row, `boardLoaded` true, `boardVersion` the queue's
// `version` (it re-reads after each queue read, as it does after each board
// read), the shared draft map, `onProjectConfirmed` a no-op. It is state,
// not address — no view's URL changes. Closing it returns focus to the row
// that opened it (the popover reopens on that row) while the review is
// still queued and was not decided here, else to the pill: a decided
// review is leaving the queue, even before the next read says so. Below
// `sm` the drawer is a modal sheet, so the view underneath is made inert,
// as BoardView does for its own.
//
// The board's own drawer (`/board?item=`, and the roadmap's, which is the
// same drawer at `/roadmap?item=`) and this one are never open together.
// Opening this one on the board or roadmap while that drawer is open pushes
// the address without `item` (closing that drawer — the one address change
// this makes, and only there; Back reopens it, which closes this one); that
// drawer opening (a card or row picked, back/forward) closes this one and
// the popover. The popover and
// the drawer remember the view they opened on and draw only there, so a
// change of view never shows them for a frame over the next view.
//
// Run-through. "Review all" closes the popover and the shell's drawer and
// mounts ReviewRunModal (design.md decision 6) over the current view with
// the live queue and the shared draft map; the address is untouched, even
// on the board with its own drawer open (the modal makes it inert
// meanwhile). Ending the run unmounts it and returns focus to the pill (or,
// when the board's drawer still makes the pill inert, to that drawer's
// title). Like the drawer, it remembers its view and ends on a change of
// view or when the board's drawer opens.

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LiveState } from "../lib/liveStream.js";
import { navigate, withAddressProjects } from "../lib/navigate.js";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import {
  countAnnouncement,
  countText,
  inboxCountLabel,
  focusReturnTarget,
  formatAge,
  formatImageCount,
  LIVE_ANNOUNCE_HOLD_MS,
  liveAnnouncement,
  liveLabel,
  liveText,
  moveActive,
  orderNote,
  pillLabel,
  popoverPlacement,
  reconcileActive,
  reviewCountLabel,
  rowLabel,
  staleNote,
  type QueueRow,
} from "../lib/reviewQueueRow.js";
import type { BoardRoute, InboxRoute, Route } from "../lib/route.js";
import { ShellLink } from "./ShellLink.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";
import { ReviewRunModal } from "./ReviewRunModal.js";

type QueueReview = ReviewQueueState["reviews"][number];
type ViewName = Route["view"];

interface ReviewQueueContextValue {
  queue: ReviewQueueState;
  live: LiveState;
  /** The pill the open popover is anchored under; null while it is closed. */
  popoverPill: HTMLElement | null;
  togglePopover: (pill: PillTarget) => void;
  openPopover: (pill: PillTarget) => void;
  closePopover: (returnFocus: boolean) => void;
  /** Move focus into the open popover (its active row). */
  focusPopover: () => void;
  /** Register a pill's button, a candidate anchor once the one that opened the popover is gone. */
  registerPill: (el: HTMLElement) => () => void;
}

/** A pill as the popover sees it: where to anchor and return focus, and where its "Go to inbox" goes (null: the address's projects). */
interface PillTarget {
  el: HTMLElement;
  inboxRoute: InboxRoute | null;
}

const ReviewQueueContext = createContext<ReviewQueueContextValue | null>(null);

function useReviewQueueContext(): ReviewQueueContextValue {
  const value = useContext(ReviewQueueContext);
  if (value === null) throw new Error("the review queue pill needs a ReviewQueueProvider above it");
  return value;
}

/** The shell's live review queue, for a view that lists reviews itself (the inbox's Needs me). */
export function useReviewQueue(): ReviewQueueState {
  return useReviewQueueContext().queue;
}

export interface ShellDrawerState {
  /** Whether the shell's queue drawer is open; a view pads itself clear of it from `sm` up. */
  open: boolean;
  /** Unsent drawer messages by bead id, shared by the board's drawer and the shell's. */
  drafts: Map<string, string>;
}

const ShellDrawerContext = createContext<ShellDrawerState>({ open: false, drafts: new Map() });

export function useShellDrawer(): ShellDrawerState {
  return useContext(ShellDrawerContext);
}

/** Keep `drafts` in step with a drawer's message box: an empty draft is no draft. */
export function storeDraft(drafts: Map<string, string>, item: string, draft: string): void {
  if (draft.trim() === "") drafts.delete(item);
  else drafts.set(item, draft);
}

const BOARD_HOME: BoardRoute = { view: "board", viewId: null, projects: [], item: null };
const INBOX_HOME: InboxRoute = { view: "inbox", item: null, projects: [] };

type PopoverState = { open: false } | { open: true; focusId: string | null; view: ViewName; pill: PillTarget | null };

export interface ReviewQueueProviderProps {
  queue: ReviewQueueState;
  live: LiveState;
  route: Route;
  children: ReactNode;
}

export function ReviewQueueProvider({ queue, live, route, children }: ReviewQueueProviderProps) {
  const pills = useRef<HTMLElement[]>([]);
  /** The pill the reader last opened the popover from: its anchor, and where focus returns. */
  const activePill = useRef<PillTarget | null>(null);
  const [anchorVersion, setAnchorVersion] = useState(0);
  const [popover, setPopover] = useState<PopoverState>({ open: false });
  const [picked, setPicked] = useState<{ review: QueueReview; view: ViewName } | null>(null);
  const [run, setRun] = useState<{ view: ViewName; key: number } | null>(null);
  const [focusPill, setFocusPill] = useState(0);
  const drafts = useRef(new Map<string, string>()).current;
  /** Reviews decided in the shell's drawer, so closing it does not return focus to a row about to leave. */
  const decided = useRef(new Set<string>());
  const popoverFocus = useRef<(() => void) | null>(null);
  const wide = useWideDrawer();
  const announcement = useQueueAnnouncement(queue, live);

  const anchor = useCallback((): HTMLElement | null => {
    const active = activePill.current?.el;
    if (active?.isConnected === true) return active;
    return pills.current.find((el) => el.isConnected) ?? null;
  }, []);

  const registerPill = useCallback((el: HTMLElement) => {
    pills.current = [...pills.current, el];
    setAnchorVersion((v) => v + 1);
    return () => {
      pills.current = pills.current.filter((p) => p !== el);
      setAnchorVersion((v) => v + 1);
    };
  }, []);

  const closePopover = useCallback(
    (returnFocus: boolean) => {
      setPopover({ open: false });
      if (returnFocus) anchor()?.focus();
    },
    [anchor],
  );

  // Focus the pill once the drawer or run that asked for it has unmounted
  // (and the view is no longer inert). A pill that is still inert — the
  // board's own drawer is a modal sheet below `sm` — cannot take focus, so
  // it goes to that drawer's title instead.
  useEffect(() => {
    if (focusPill === 0) return;
    const pill = anchor();
    if (pill !== null && pill.closest("[inert]") === null) pill.focus();
    else document.querySelector<HTMLElement>("[data-panel-title]")?.focus();
  }, [focusPill, anchor]);

  function openReview(review: QueueReview) {
    setPopover({ open: false });
    decided.current.delete(review.id);
    if ((route.view === "board" || route.view === "roadmap") && route.item !== null) navigate({ ...route, item: null }, "push");
    setPicked({ review, view: route.view });
  }

  function startRun() {
    setPopover({ open: false });
    setPicked(null);
    setRun((r) => ({ view: route.view, key: (r?.key ?? 0) + 1 }));
  }

  function endRun() {
    setRun(null);
    setFocusPill((n) => n + 1);
  }

  function closeDrawer() {
    if (picked === null) return;
    const id = picked.review.id;
    const target = decided.current.has(id) ? ({ kind: "pill" } as const) : focusReturnTarget(id, queue.reviews);
    setPicked(null);
    if (target.kind === "row") setPopover({ open: true, focusId: target.id, view: route.view, pill: activePill.current });
    else setFocusPill((n) => n + 1);
  }

  // The board's drawer opening closes this one, and the popover over it.
  const boardItem = route.view === "board" || route.view === "roadmap" ? route.item : null;
  useEffect(() => {
    if (boardItem === null) return;
    setPicked(null);
    setPopover({ open: false });
    setRun(null);
  }, [boardItem]);

  // A change of view drops the popover and the drawer (they already draw only on their own view).
  useEffect(() => {
    setPopover((p) => (p.open && p.view !== route.view ? { open: false } : p));
    setPicked((p) => (p !== null && p.view !== route.view ? null : p));
    setRun((r) => (r !== null && r.view !== route.view ? null : r));
  }, [route.view]);

  const view = route.view;
  const popoverPill = popover.open ? (popover.pill?.el ?? null) : null;
  const value = useMemo<ReviewQueueContextValue>(
    () => ({
      queue,
      live,
      popoverPill,
      togglePopover: (pill) => {
        activePill.current = pill;
        setPopover((p) => (p.open && p.pill?.el === pill.el ? { open: false } : { open: true, focusId: null, view, pill }));
      },
      openPopover: (pill) => {
        activePill.current = pill;
        setPopover({ open: true, focusId: null, view, pill });
      },
      closePopover,
      focusPopover: () => popoverFocus.current?.(),
      registerPill,
    }),
    [queue, live, popoverPill, view, closePopover, registerPill],
  );

  const shownPicked = picked !== null && picked.view === route.view ? picked.review : null;
  const shownPopover = popover.open && popover.view === route.view ? popover : null;
  const shownRun = run !== null && run.view === route.view ? run : null;
  const shellOpen = shownPicked !== null;
  const drawerState = useMemo<ShellDrawerState>(() => ({ open: shellOpen, drafts }), [shellOpen, drafts]);
  const modalDrawer = shellOpen && !wide;

  return (
    <ReviewQueueContext.Provider value={value}>
      <ShellDrawerContext.Provider value={drawerState}>
        <div inert={modalDrawer}>{children}</div>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {shownPopover !== null &&
          createPortal(
            <QueuePopover
              anchor={anchor}
              anchorVersion={anchorVersion}
              queue={queue}
              live={live}
              initialFocusId={shownPopover.focusId}
              showBoardLink={route.view !== "board"}
              inboxRoute={route.view === "inbox" ? null : (shownPopover.pill?.inboxRoute ?? withAddressProjects(INBOX_HOME))}
              focusRef={popoverFocus}
              onPick={openReview}
              onClose={closePopover}
              onReviewAll={startRun}
            />,
            document.body,
          )}
        {shownPicked !== null && (
          <ReviewDrawer
            key={`${shownPicked.project}\u0000${shownPicked.externalId}`}
            project={shownPicked.project}
            item={shownPicked.externalId}
            boardLoaded
            boardVersion={queue.version}
            initialDraft={drafts.get(shownPicked.externalId) ?? ""}
            onDraftChange={(draft) => storeDraft(drafts, shownPicked.externalId, draft)}
            onDecided={() => decided.current.add(shownPicked.id)}
            onProjectConfirmed={() => {}}
            onClose={closeDrawer}
          />
        )}
        {shownRun !== null && <ReviewRunModal key={shownRun.key} queue={queue} drafts={drafts} onEnd={endRun} />}
      </ShellDrawerContext.Provider>
    </ReviewQueueContext.Provider>
  );
}

/** The status region's text: count changes after the first read, and lasting live/offline changes (see the header). */
function useQueueAnnouncement(queue: ReviewQueueState, live: LiveState): string {
  const [text, setText] = useState("");
  const lastTotal = useRef<number | null>(null);
  const settled = useRef<LiveState | null>(null);

  useEffect(() => {
    if (!queue.loaded) return;
    const message = countAnnouncement(lastTotal.current, queue.total);
    lastTotal.current = queue.total;
    if (message !== null) setText(message);
  }, [queue.loaded, queue.total]);

  useEffect(() => {
    if (live === "connecting") return;
    const timer = setTimeout(() => {
      const message = liveAnnouncement(settled.current, live);
      settled.current = live;
      if (message !== null) setText(message);
    }, LIVE_ANNOUNCE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [live]);

  return text;
}

export interface ReviewQueuePillProps {
  /** `inline` sits in a header bar; `floating` stands alone (the graph's right column) with its own surface. */
  variant?: "inline" | "floating";
  /** The light and bare counts, at every width (the shell header's tighter tiers); the state word stays in the accessible name. */
  compact?: boolean;
  /** Inbox items needing the reader that are not reviews (shown when greater than 0); null or absent shows none. */
  inboxCount?: number | null;
  /** Where the popover's "Go to inbox" goes from this pill; absent: the inbox with the address's projects. */
  inboxRoute?: InboxRoute;
}

/** The review control: the shell header's, and the pill a view still places in its own header. */
export function ReviewQueuePill({ variant = "inline", compact = false, inboxCount = null, inboxRoute }: ReviewQueuePillProps) {
  const { queue, live, popoverPill, togglePopover, openPopover, closePopover, focusPopover, registerPill } = useReviewQueueContext();
  const ref = useRef<HTMLButtonElement>(null);
  const expanded = popoverPill !== null && popoverPill === ref.current;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    return registerPill(el);
  }, [registerPill]);

  function target(): PillTarget | null {
    return ref.current === null ? null : { el: ref.current, inboxRoute: inboxRoute ?? null };
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const pill = target();
      if (expanded) focusPopover();
      else if (pill !== null) openPopover(pill);
    } else if (e.key === "Escape" && expanded) {
      e.preventDefault();
      closePopover(false);
    }
  }

  const zero = !queue.loaded || queue.total === 0;
  const inboxShown = inboxCount !== null && inboxCount > 0;
  const surface = variant === "floating" ? "h-11 sm:h-8 bg-surface-strong backdrop-blur-lg shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]" : "h-11 sm:h-7";
  const ring = expanded ? "border-accent/60 ring-2 ring-accent ring-offset-2 ring-offset-ground" : "border-hairline hover:bg-surface-strong";
  const spacing = compact ? "gap-1.5 pr-[5px] pl-2.5" : "gap-2 pr-[5px] pl-3";

  return (
    <button
      ref={ref}
      type="button"
      title={pillLabel(queue.total, queue.loaded, live, inboxCount)}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={() => {
        const pill = target();
        if (pill !== null) togglePopover(pill);
      }}
      onKeyDown={onKeyDown}
      data-review-control=""
      className={`inline-flex shrink-0 items-center rounded-full border text-xs whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${spacing} ${surface} ${ring}`}
    >
      {/* Wide enough for "Connecting…" from `sm` up, so a state flip never moves the header's other controls. */}
      <span className={`inline-flex items-center gap-2 ${compact ? "" : "sm:min-w-[5.25rem]"}`}>
        <StatusLight live={live} />
        {!compact && (
          <span aria-hidden="true" className="hidden text-fg-muted sm:inline">
            {liveText(live)}
          </span>
        )}
      </span>
      <span className="sr-only">{liveLabel(live)}, </span>
      {!compact && <span aria-hidden="true" className="h-3.5 w-px bg-hairline" />}
      <span className="sr-only" data-count="reviews">
        {reviewCountLabel(queue.total, queue.loaded)}
      </span>
      <CountBadge zero={zero} decorative>
        {compact ? (queue.loaded ? queue.total : "…") : countText(queue.total, queue.loaded)}
      </CountBadge>
      {inboxShown && (
        <>
          <span className="sr-only" data-count="inbox">
            , {inboxCountLabel(inboxCount)}
          </span>
          <span aria-hidden="true" className="inline-flex h-[22px] items-center gap-1 rounded-full border border-hairline px-1.5 font-semibold text-fg tabular-nums">
            <InboxIcon />
            {inboxCount}
          </span>
        </>
      )}
    </button>
  );
}

function InboxIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="text-fg-muted">
      <path d="M2 9.5 3.75 3h8.5L14 9.5V13H2z" />
      <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" />
    </svg>
  );
}

/** Filled = live, half = connecting, ring = offline: the shape carries the state, not only the colour. */
function StatusLight({ live }: { live: LiveState }) {
  const cls =
    live === "live"
      ? "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]"
      : live === "connecting"
        ? "border-[1.5px] border-amber-400 bg-[linear-gradient(90deg,var(--color-amber-400)_50%,transparent_50%)]"
        : "border-[1.5px] border-red-400";
  return <span aria-hidden="true" data-live={live} className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}

/** A count in a badge; `decorative` hides it from assistive technology where sr-only text says it instead. */
function CountBadge({ zero, decorative = false, children }: { zero: boolean; decorative?: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden={decorative ? "true" : undefined}
      className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border px-[7px] text-xs whitespace-nowrap ${
        zero ? "border-hairline font-medium text-fg-muted" : "border-accent/60 bg-accent/[0.18] font-semibold text-fg"
      }`}
    >
      {children}
    </span>
  );
}

interface QueuePopoverProps {
  anchor: () => HTMLElement | null;
  anchorVersion: number;
  queue: ReviewQueueState;
  live: LiveState;
  /** The row to focus on open (the drawer closing on it); null focuses the first. */
  initialFocusId: string | null;
  showBoardLink: boolean;
  /** Where "Go to inbox" goes; null hides it (on the inbox itself). */
  inboxRoute: InboxRoute | null;
  /** Set to this popover's "focus the active row" while it is mounted. */
  focusRef: { current: (() => void) | null };
  onPick: (review: QueueReview) => void;
  onClose: (returnFocus: boolean) => void;
  onReviewAll: () => void;
}

type Placement = { top: number; right: number; width: number };

/** Where the popover goes for a pill (lib/reviewQueueRow.ts `popoverPlacement`); null with no pill. */
function placeUnder(el: HTMLElement | null): Placement | null {
  if (el === null) return null;
  return popoverPlacement(el.getBoundingClientRect(), document.documentElement.clientWidth);
}

function samePlacement(a: Placement | null, b: Placement | null): boolean {
  return a === b || (a !== null && b !== null && a.top === b.top && a.right === b.right && a.width === b.width);
}

/** How often the open popover refreshes its ages. */
const AGE_TICK_MS = 30_000;

const TABBABLE = "button:not([disabled]):not([tabindex='-1']), a[href]";

const FOOTER_LINK = "inline-flex min-h-11 items-center rounded text-xs text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0";

function QueuePopover({ anchor, anchorVersion, queue, live, initialFocusId, showBoardLink, inboxRoute, focusRef, onPick, onClose, onReviewAll }: QueuePopoverProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const reviews = queue.reviews;
  const [active, setActive] = useState(() => Math.max(0, initialFocusId === null ? 0 : reviews.findIndex((r) => r.id === initialFocusId)));
  const activeId = useRef<string | null>(reviews[active]?.id ?? null);
  const focusInList = useRef(false);
  // Placed before the first paint and before the focus effect runs: a row under `visibility: hidden` cannot take focus.
  const [pos, setPos] = useState(() => placeUnder(anchor()));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Follow the pill every frame while open: it can move with no resize or scroll event.
  useLayoutEffect(() => {
    let frame = 0;
    let last = placeUnder(anchor());
    setPos(last);
    function follow() {
      const next = placeUnder(anchor());
      if (next !== null && !samePlacement(last, next)) {
        last = next;
        setPos(next);
      }
      frame = requestAnimationFrame(follow);
    }
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [anchor, anchorVersion]);

  // No pill to anchor to (the view went away under it): close.
  useEffect(() => {
    if (anchor() === null) onClose(false);
  }, [anchor, anchorVersion, onClose]);

  function focusActive() {
    const review = reviews[active];
    if (review !== undefined) rowRefs.current.get(review.id)?.focus();
    else rootRef.current?.focus();
  }

  useEffect(() => {
    focusRef.current = focusActive;
    return () => {
      focusRef.current = null;
    };
  });

  function focusRow(index: number) {
    const review = reviews[index];
    if (review === undefined) return;
    activeId.current = review.id;
    setActive(index);
    rowRefs.current.get(review.id)?.focus();
  }

  // Focus the first (or the asked-for) row on open, or the dialog itself when the queue is empty.
  useEffect(() => {
    focusActive();
    // Mount only: later list changes are reconciled below.
  }, []);

  // The list changed under the popover: keep the same review active, or the one now in its place.
  useEffect(() => {
    const next = reconcileActive(activeId.current, active, reviews);
    const nextId = reviews[next]?.id ?? null;
    if (next !== active) setActive(Math.max(next, 0));
    activeId.current = nextId;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (focusInList.current && lost) {
      if (nextId !== null) rowRefs.current.get(nextId)?.focus();
      else rootRef.current?.focus();
    }
  }, [reviews]);

  // A press outside the popover and its pill closes it, leaving focus where the press put it.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (target === null || rootRef.current?.contains(target) || anchor()?.contains(target)) return;
      onClose(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor, onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key !== "Tab" || rootRef.current === null) return;
    // Portalled to the end of <body>, the popover is last in the tab order:
    // leaving it either way goes back to the pill, as if it sat right after it.
    const tabbables = [...rootRef.current.querySelectorAll<HTMLElement>(TABBABLE)];
    const first = tabbables[0];
    const last = tabbables.at(-1);
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === rootRef.current)) {
      e.preventDefault();
      onClose(true);
    } else if (!e.shiftKey && (current === last || tabbables.length === 0)) {
      // Focus the pill and let this Tab carry on from it to whatever follows.
      onClose(true);
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const next = moveActive(active, e.key, reviews.length);
    if (next === null) return;
    e.preventDefault();
    focusRow(next);
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    const to = e.relatedTarget as Node | null;
    if (to === null || rootRef.current?.contains(to) || anchor()?.contains(to)) return;
    onClose(false);
  }

  const stale = staleNote(live);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={pos === null ? { visibility: "hidden" } : { top: pos.top, right: pos.right, width: pos.width }}
      className="fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-strong text-fg shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65),0_24px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur-lg focus:outline-none"
    >
      <div className="border-b border-hairline px-3.5 py-3">
        <div className="flex min-h-7 items-center gap-2.5">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Reviews waiting
          </h2>
          <CountBadge zero={!queue.loaded || queue.total === 0}>{queue.loaded ? queue.total : "…"}</CountBadge>
          <button
            type="button"
            onClick={onReviewAll}
            disabled={reviews.length === 0}
            className="ml-auto min-h-11 rounded-lg bg-accent px-3 text-xs font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50 sm:min-h-7"
          >
            Review all
          </button>
        </div>
        <p className="mt-1 text-[11px] text-fg-muted">{orderNote(reviews.length, queue.total, queue.truncated)}</p>
        {stale !== null && (
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <StatusLight live={live} />
            {stale}
          </p>
        )}
      </div>

      {queue.error !== null && (
        <p role="alert" className="border-b border-hairline bg-red-500/10 px-3.5 py-2 text-xs text-red-300">
          Couldn't read the queue: {queue.error}
          {queue.loaded && " Showing the last answer."}
        </p>
      )}

      {reviews.length === 0 ? (
        <p className="px-4 py-7 text-center text-[13px] text-fg-muted">{queue.loaded ? "No reviews waiting" : "Reading the queue…"}</p>
      ) : (
        <ul
          role="list"
          aria-label="Pending reviews, oldest first"
          onKeyDown={onListKeyDown}
          onFocus={() => (focusInList.current = true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInList.current = false;
          }}
          className="flex min-h-0 flex-col gap-0.5 overflow-auto p-1.5"
        >
          {reviews.map((review, i) => (
            <li key={review.id}>
              <QueueRowButton
                review={review}
                now={now}
                active={i === active}
                buttonRef={(el) => {
                  if (el === null) rowRefs.current.delete(review.id);
                  else rowRefs.current.set(review.id, el);
                }}
                onFocus={() => {
                  activeId.current = review.id;
                  setActive(i);
                }}
                onPick={() => onPick(review)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-3.5 py-2 text-[11px] text-fg-muted">
        <span aria-hidden="true" className="hidden items-center gap-3 sm:flex">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </span>
        {(showBoardLink || inboxRoute !== null) && (
          <span className="ml-auto flex items-center gap-3">
            {showBoardLink && (
              <ShellLink route={withAddressProjects(BOARD_HOME)} onNavigate={() => onClose(false)} className={FOOTER_LINK}>
                Open the board
              </ShellLink>
            )}
            {inboxRoute !== null && (
              <ShellLink route={inboxRoute} onNavigate={() => onClose(false)} className={FOOTER_LINK}>
                Go to inbox
              </ShellLink>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-b-2 border-hairline px-1 font-mono text-[10px] text-fg">{children}</kbd>;
}

function QueueRowButton({
  review,
  now,
  active,
  buttonRef,
  onFocus,
  onPick,
}: {
  review: QueueRow;
  now: number;
  active: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onPick: () => void;
}) {
  const summaryId = useId();
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={active ? 0 : -1}
      aria-label={rowLabel(review, now)}
      aria-describedby={review.summaryLine !== null ? summaryId : undefined}
      data-review-id={review.id}
      onFocus={onFocus}
      onClick={onPick}
      className={`block w-full rounded-[10px] border p-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active ? "border-hairline bg-fg/5" : "border-transparent hover:bg-fg/5"
      }`}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        <span className="rounded-full border border-hairline px-[7px] py-px text-fg">{review.project}</span>
        <span className="truncate font-mono">{review.externalId}</span>
        <time dateTime={review.requestedAt} className="ml-auto shrink-0 tabular-nums">
          {formatAge(review.requestedAt, now)}
        </time>
      </span>
      <span className="mt-1.5 line-clamp-2 text-sm leading-snug text-fg">{review.title.trim() || "(untitled)"}</span>
      {review.summaryLine !== null && (
        <span id={summaryId} className="mt-0.5 block truncate text-xs text-fg-muted">
          {review.summaryLine}
        </span>
      )}
      <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
        <ImageIcon />
        {formatImageCount(review.imageCount)}
      </span>
    </button>
  );
}

function ImageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <circle cx="5.5" cy="6.5" r="1.25" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
    </svg>
  );
}
