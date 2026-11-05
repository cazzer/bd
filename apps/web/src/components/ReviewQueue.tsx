// The review queue in the shell (review-queue, design.md decisions 3-4,
// prototype A): the queue state App.tsx reads once, outside its view
// switch, shared through `ReviewQueueContext`; the pill each view places in
// its own top-right header (`ReviewQueuePill`); the popover anchored under
// it; and the drawer a pick opens over the current view.
//
// Two contexts, so a queue read re-renders only what shows the queue. The
// queue context (queue, live state, popover actions) is read by the pills
// alone. `ShellDrawerContext` carries whether the shell's drawer is open —
// which views read to pad themselves clear of it, as the board already does
// for its own — and the one draft map both drawers share, keyed by bead id,
// so a message typed in either survives a switch to the other.
//
// Pill. A button holding the status light (filled green = live, half amber
// = connecting, red ring = offline — shape as well as colour), the word for
// that state (from `sm` up; below it the light's shape and the accessible
// name carry it), and the pending count; its accessible name reads the same
// way ("Live, 3 reviews waiting", lib/reviewQueueRow.ts `pillLabel`). The
// state word sits in a box wide enough for "Connecting…", so a flip never
// shifts the header. Views place the pill; each placed pill registers with
// the provider, and while none is registered (a view that does not place
// one, a lazy view still loading, the code view's empty states) the
// provider draws the same pill fixed top-right, so no view is ever without
// it. Registration is a layout effect, so the fallback never paints for a
// frame under a view that places its own. ArrowDown on the pill opens the
// popover, or focuses its active row when it is open; Escape closes it.
//
// Announcements. One polite status region (here, not per pill, so a view
// change says nothing). It speaks a change of the count after the first
// read, and a lasting change of the stream between live and offline (held
// LIVE_ANNOUNCE_HOLD_MS); never the first load, a reconnect, or connecting.
//
// Popover. Anchored under the pill (portalled to <body> and positioned from
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
// 6) sits in the header and is rendered only when the provider is given
// `onReviewAll`; the run-through modal is task group 6, so App.tsx passes
// none yet and the button is hidden.
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
// The board's own drawer (`/board?item=`) and this one are never open
// together. Opening this one on the board while the board's is open pushes
// the address without `item` (closing the board's drawer — the one address
// change this makes, and only on the board; Back reopens the board's
// drawer, which closes this one); the board's drawer opening (a card
// picked, back/forward) closes this one and the popover. The popover and
// the drawer remember the view they opened on and draw only there, so a
// change of view never shows them for a frame over the next view.

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LiveState } from "../lib/liveStream.js";
import { navigate } from "../lib/navigate.js";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import {
  countAnnouncement,
  countText,
  focusReturnTarget,
  formatAge,
  formatImageCount,
  LIVE_ANNOUNCE_HOLD_MS,
  liveAnnouncement,
  liveText,
  moveActive,
  orderNote,
  pillLabel,
  popoverPlacement,
  reconcileActive,
  rowLabel,
  staleNote,
  type QueueRow,
} from "../lib/reviewQueueRow.js";
import { formatRoute, type BoardRoute, type Route } from "../lib/route.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";

type QueueReview = ReviewQueueState["reviews"][number];
type ViewName = Route["view"];

interface ReviewQueueContextValue {
  queue: ReviewQueueState;
  live: LiveState;
  popoverOpen: boolean;
  togglePopover: () => void;
  openPopover: () => void;
  closePopover: (returnFocus: boolean) => void;
  /** Move focus into the open popover (its active row). */
  focusPopover: () => void;
  /** Register a pill's button as the popover's anchor; `placed` is false only for the shell's fallback. */
  registerPill: (el: HTMLElement, placed: boolean) => () => void;
}

const ReviewQueueContext = createContext<ReviewQueueContextValue | null>(null);

function useReviewQueueContext(): ReviewQueueContextValue {
  const value = useContext(ReviewQueueContext);
  if (value === null) throw new Error("the review queue pill needs a ReviewQueueProvider above it");
  return value;
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

interface PillEntry {
  el: HTMLElement;
  placed: boolean;
}

type PopoverState = { open: false } | { open: true; focusId: string | null; view: ViewName };

export interface ReviewQueueProviderProps {
  queue: ReviewQueueState;
  live: LiveState;
  route: Route;
  /** Starts the review-all run (task group 6); the popover hides "Review all" while absent. */
  onReviewAll?: () => void;
  children: ReactNode;
}

export function ReviewQueueProvider({ queue, live, route, onReviewAll, children }: ReviewQueueProviderProps) {
  const pills = useRef<PillEntry[]>([]);
  const [placedCount, setPlacedCount] = useState(0);
  const [anchorVersion, setAnchorVersion] = useState(0);
  const [popover, setPopover] = useState<PopoverState>({ open: false });
  const [picked, setPicked] = useState<{ review: QueueReview; view: ViewName } | null>(null);
  const [focusPill, setFocusPill] = useState(0);
  const drafts = useRef(new Map<string, string>()).current;
  /** Reviews decided in the shell's drawer, so closing it does not return focus to a row about to leave. */
  const decided = useRef(new Set<string>());
  const popoverFocus = useRef<(() => void) | null>(null);
  const wide = useWideDrawer();
  const announcement = useQueueAnnouncement(queue, live);

  const anchor = useCallback((): HTMLElement | null => {
    const connected = pills.current.filter((p) => p.el.isConnected);
    return (connected.findLast((p) => p.placed) ?? connected.at(-1))?.el ?? null;
  }, []);

  const registerPill = useCallback((el: HTMLElement, placed: boolean) => {
    const entry: PillEntry = { el, placed };
    pills.current = [...pills.current, entry];
    if (placed) setPlacedCount((n) => n + 1);
    setAnchorVersion((v) => v + 1);
    return () => {
      pills.current = pills.current.filter((p) => p !== entry);
      if (placed) setPlacedCount((n) => n - 1);
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

  // Focus the pill once the drawer that asked for it has unmounted (and the view is no longer inert).
  useEffect(() => {
    if (focusPill > 0) anchor()?.focus();
  }, [focusPill, anchor]);

  function openReview(review: QueueReview) {
    setPopover({ open: false });
    decided.current.delete(review.id);
    if (route.view === "board" && route.item !== null) navigate({ ...route, item: null }, "push");
    setPicked({ review, view: route.view });
  }

  function closeDrawer() {
    if (picked === null) return;
    const id = picked.review.id;
    const target = decided.current.has(id) ? ({ kind: "pill" } as const) : focusReturnTarget(id, queue.reviews);
    setPicked(null);
    if (target.kind === "row") setPopover({ open: true, focusId: target.id, view: route.view });
    else setFocusPill((n) => n + 1);
  }

  // The board's drawer opening closes this one, and the popover over it.
  const boardItem = route.view === "board" ? route.item : null;
  useEffect(() => {
    if (boardItem === null) return;
    setPicked(null);
    setPopover({ open: false });
  }, [boardItem]);

  // A change of view drops the popover and the drawer (they already draw only on their own view).
  useEffect(() => {
    setPopover((p) => (p.open && p.view !== route.view ? { open: false } : p));
    setPicked((p) => (p !== null && p.view !== route.view ? null : p));
  }, [route.view]);

  const view = route.view;
  const value = useMemo<ReviewQueueContextValue>(
    () => ({
      queue,
      live,
      popoverOpen: popover.open,
      togglePopover: () => setPopover((p) => (p.open ? { open: false } : { open: true, focusId: null, view })),
      openPopover: () => setPopover({ open: true, focusId: null, view }),
      closePopover,
      focusPopover: () => popoverFocus.current?.(),
      registerPill,
    }),
    [queue, live, popover.open, view, closePopover, registerPill],
  );

  const shownPicked = picked !== null && picked.view === route.view ? picked.review : null;
  const shownPopover = popover.open && popover.view === route.view ? popover : null;
  const shellOpen = shownPicked !== null;
  const drawerState = useMemo<ShellDrawerState>(() => ({ open: shellOpen, drafts }), [shellOpen, drafts]);
  const modalDrawer = shellOpen && !wide;

  return (
    <ReviewQueueContext.Provider value={value}>
      <ShellDrawerContext.Provider value={drawerState}>
        <div inert={modalDrawer}>
          {children}
          {placedCount === 0 && (
            <div className="pointer-events-none fixed top-4 right-4 z-30">
              <div className="pointer-events-auto">
                <PillButton variant="floating" placed={false} />
              </div>
            </div>
          )}
        </div>
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
              focusRef={popoverFocus}
              onPick={openReview}
              onClose={closePopover}
              onReviewAll={onReviewAll}
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
}

/** The queue indicator a view places in its own top-right header. */
export function ReviewQueuePill({ variant = "inline" }: ReviewQueuePillProps) {
  return <PillButton variant={variant} placed />;
}

function PillButton({ variant, placed }: { variant: "inline" | "floating"; placed: boolean }) {
  const { queue, live, popoverOpen, togglePopover, openPopover, closePopover, focusPopover, registerPill } = useReviewQueueContext();
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    return registerPill(el, placed);
  }, [registerPill, placed]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (popoverOpen) focusPopover();
      else openPopover();
    } else if (e.key === "Escape" && popoverOpen) {
      e.preventDefault();
      closePopover(false);
    }
  }

  const zero = !queue.loaded || queue.total === 0;
  const surface = variant === "floating" ? "h-11 sm:h-8 bg-surface-strong backdrop-blur-lg shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]" : "h-11 sm:h-7";
  const expanded = popoverOpen ? "border-accent/60 ring-2 ring-accent ring-offset-2 ring-offset-ground" : "border-hairline hover:bg-surface-strong";

  return (
    <button
      ref={ref}
      type="button"
      aria-label={pillLabel(queue.total, queue.loaded, live)}
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      onClick={togglePopover}
      onKeyDown={onKeyDown}
      data-review-pill={placed ? "placed" : "fallback"}
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border pr-[5px] pl-3 text-xs whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${surface} ${expanded}`}
    >
      {/* Wide enough for "Connecting…" from `sm` up, so a state flip never moves the header's other controls. */}
      <span className="inline-flex items-center justify-end gap-2 sm:min-w-[5.25rem]">
        <StatusLight live={live} />
        <span className="hidden text-fg-muted sm:inline">{liveText(live)}</span>
      </span>
      <span aria-hidden="true" className="h-3.5 w-px bg-hairline" />
      <CountBadge zero={zero}>{countText(queue.total, queue.loaded)}</CountBadge>
    </button>
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

function CountBadge({ zero, children }: { zero: boolean; children: ReactNode }) {
  return (
    <span
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
  /** Set to this popover's "focus the active row" while it is mounted. */
  focusRef: { current: (() => void) | null };
  onPick: (review: QueueReview) => void;
  onClose: (returnFocus: boolean) => void;
  onReviewAll: (() => void) | undefined;
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

function QueuePopover({ anchor, anchorVersion, queue, live, initialFocusId, showBoardLink, focusRef, onPick, onClose, onReviewAll }: QueuePopoverProps) {
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

  function openBoard(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onClose(false);
    navigate(BOARD_HOME, "push");
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
          {onReviewAll !== undefined && (
            <button
              type="button"
              onClick={onReviewAll}
              disabled={reviews.length === 0}
              className="ml-auto min-h-11 rounded-lg bg-accent px-3 text-xs font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50 sm:min-h-7"
            >
              Review all
            </button>
          )}
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
        {showBoardLink && (
          <a
            href={formatRoute(BOARD_HOME)}
            onClick={openBoard}
            className="ml-auto inline-flex min-h-11 items-center rounded text-xs text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0"
          >
            Open the board
          </a>
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
