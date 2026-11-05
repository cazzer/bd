// The review queue in the shell (review-queue, design.md decisions 3-4,
// prototype A): the queue state App.tsx reads once, outside its view
// switch, shared through `ReviewQueueContext`; the pill each view places in
// its own top-right header (`ReviewQueuePill`); the popover anchored under
// it; and the drawer a pick opens over the current view.
//
// Pill. A button holding the status light (filled green = live, half amber
// = connecting, red ring = offline — shape as well as colour), the word for
// that state, and the pending count; its accessible name carries both
// (lib/reviewQueueRow.ts `pillLabel`). Views place it; each placed pill
// registers with the provider, and while none is registered (a view that
// does not place one, a lazy view still loading, the code view's empty
// states) the provider draws the same pill fixed top-right, so no view is
// ever without it. Registration is a layout effect, so the fallback never
// paints for a frame under a view that places its own. One polite status
// region (here, not per pill, so a view change re-announces nothing) reads
// out the pill's label as it changes.
//
// Popover. Anchored under the pill (portalled to <body> and positioned from
// the pill's rect, since the headers it sits in are `glass` — a
// backdrop-filter makes them the containing block of anything fixed inside
// them — and the code view's clips). A non-modal dialog: rows oldest first,
// arrows / Home / End move between them (roving tabindex), Enter or a click
// picks, Escape closes it and returns focus to the pill, and a click or
// focus outside it closes it without moving focus. It shows an empty state,
// the truncation note, and the queue's read error over the last answer.
// "Review all" (design.md decision 6) is rendered only when the provider is
// given `onReviewAll`; the run-through modal is task group 6, so App.tsx
// passes none yet and the button is hidden.
//
// Drawer. A pick opens the board's ReviewDrawer from here (decision 4): the
// project from the row, `boardLoaded` true, `boardVersion` the queue's
// `version` (it re-reads after each queue read, as it does after each board
// read), drafts in a map here, `onProjectConfirmed` a no-op. It is state,
// not address — no view's URL changes. Closing it returns focus to the row
// that opened it (the popover reopens on that row) while the review is
// still queued, else to the pill. Below `sm` the drawer is a modal sheet,
// so the view underneath is made inert, as BoardView does for its own.
//
// The board's own drawer (`/board?item=`) and this one are never open
// together. Opening this one on the board while the board's is open
// replace-navigates `item` away (closing the board's drawer — the one
// address change this makes, and only on the board); the board's drawer
// opening (a card picked, back/forward) closes this one. A change of view
// closes the popover and this drawer, since what they covered has gone.

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LiveState } from "../lib/liveStream.js";
import { navigate } from "../lib/navigate.js";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import { countText, focusReturnTarget, formatAge, formatImageCount, liveText, moveActive, pillLabel, popoverPlacement, reconcileActive, rowLabel, truncationNote, type QueueRow } from "../lib/reviewQueueRow.js";
import { formatRoute, type BoardRoute, type Route } from "../lib/route.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";

type QueueReview = ReviewQueueState["reviews"][number];

interface ReviewQueueContextValue {
  queue: ReviewQueueState;
  live: LiveState;
  popoverOpen: boolean;
  /** Whether the shell's drawer is open (the board pads itself clear of it). */
  drawerOpen: boolean;
  togglePopover: () => void;
  openPopover: () => void;
  /** Register a pill's button as the popover's anchor; `placed` is false only for the shell's fallback. */
  registerPill: (el: HTMLElement, placed: boolean) => () => void;
}

const ReviewQueueContext = createContext<ReviewQueueContextValue | null>(null);

export function useReviewQueueContext(): ReviewQueueContextValue {
  const value = useContext(ReviewQueueContext);
  if (value === null) throw new Error("useReviewQueueContext needs a ReviewQueueProvider above it");
  return value;
}

const BOARD_HOME: BoardRoute = { view: "board", viewId: null, projects: [], item: null };

interface PillEntry {
  el: HTMLElement;
  placed: boolean;
}

type PopoverState = { open: false } | { open: true; focusId: string | null };

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
  const [picked, setPicked] = useState<QueueReview | null>(null);
  const [focusPill, setFocusPill] = useState(0);
  const drafts = useRef(new Map<string, string>());
  const wide = useWideDrawer();

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
    if (route.view === "board" && route.item !== null) navigate({ ...route, item: null }, "replace");
    setPicked(review);
  }

  function closeDrawer() {
    if (picked === null) return;
    const target = focusReturnTarget(picked.id, queue.reviews);
    setPicked(null);
    if (target.kind === "row") setPopover({ open: true, focusId: target.id });
    else setFocusPill((n) => n + 1);
  }

  // The board's drawer opening closes this one.
  const boardItem = route.view === "board" ? route.item : null;
  useEffect(() => {
    if (boardItem !== null) setPicked(null);
  }, [boardItem]);

  // A change of view closes the popover and the drawer.
  const lastView = useRef(route.view);
  useEffect(() => {
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    setPopover({ open: false });
    setPicked(null);
  }, [route.view]);

  const value = useMemo<ReviewQueueContextValue>(
    () => ({
      queue,
      live,
      popoverOpen: popover.open,
      drawerOpen: picked !== null,
      togglePopover: () => setPopover((p) => (p.open ? { open: false } : { open: true, focusId: null })),
      openPopover: () => setPopover({ open: true, focusId: null }),
      registerPill,
    }),
    [queue, live, popover.open, picked, registerPill],
  );

  const modalDrawer = picked !== null && !wide;
  const pickedKey = picked === null ? "" : `${picked.project}\u0000${picked.externalId}`;

  return (
    <ReviewQueueContext.Provider value={value}>
      <div inert={modalDrawer}>
        {children}
        {placedCount === 0 && (
          <div className="pointer-events-none fixed top-3 right-3 z-30">
            <div className="pointer-events-auto">
              <PillButton variant="floating" placed={false} />
            </div>
          </div>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {pillLabel(queue.total, queue.loaded, live)}
      </p>
      {popover.open &&
        createPortal(
          <QueuePopover
            anchor={anchor}
            anchorVersion={anchorVersion}
            queue={queue}
            initialFocusId={popover.focusId}
            showBoardLink={route.view !== "board"}
            onPick={openReview}
            onClose={closePopover}
            onReviewAll={onReviewAll}
          />,
          document.body,
        )}
      {picked !== null && (
        <ReviewDrawer
          key={pickedKey}
          project={picked.project}
          item={picked.externalId}
          boardLoaded
          boardVersion={queue.version}
          initialDraft={drafts.current.get(pickedKey) ?? ""}
          onDraftChange={(draft) => {
            if (draft.trim() === "") drafts.current.delete(pickedKey);
            else drafts.current.set(pickedKey, draft);
          }}
          onDecided={() => {}}
          onProjectConfirmed={() => {}}
          onClose={closeDrawer}
        />
      )}
    </ReviewQueueContext.Provider>
  );
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
  const { queue, live, popoverOpen, togglePopover, openPopover, registerPill } = useReviewQueueContext();
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    return registerPill(el, placed);
  }, [registerPill, placed]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" && !popoverOpen) {
      e.preventDefault();
      openPopover();
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
      <StatusLight live={live} />
      <span className="text-fg-muted">{liveText(live)}</span>
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
  /** The row to focus on open (the drawer closing on it); null focuses the first. */
  initialFocusId: string | null;
  showBoardLink: boolean;
  onPick: (review: QueueReview) => void;
  onClose: (returnFocus: boolean) => void;
  onReviewAll: (() => void) | undefined;
}

/** Where the popover goes for a pill (lib/reviewQueueRow.ts `popoverPlacement`); null with no pill. */
function placeUnder(el: HTMLElement | null): { top: number; right: number; width: number } | null {
  if (el === null) return null;
  return popoverPlacement(el.getBoundingClientRect(), document.documentElement.clientWidth);
}

/** How often the open popover refreshes its ages. */
const AGE_TICK_MS = 30_000;

function QueuePopover({ anchor, anchorVersion, queue, initialFocusId, showBoardLink, onPick, onClose, onReviewAll }: QueuePopoverProps) {
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

  // Anchored under the pill, right edges aligned; follows it on scroll and resize.
  useLayoutEffect(() => {
    function place() {
      const next = placeUnder(anchor());
      if (next !== null) setPos(next);
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, anchorVersion]);

  // No pill to anchor to (the view went away under it): close.
  useEffect(() => {
    if (anchor() === null) onClose(false);
  }, [anchor, anchorVersion, onClose]);

  function focusRow(index: number) {
    const review = reviews[index];
    if (review === undefined) return;
    activeId.current = review.id;
    setActive(index);
    rowRefs.current.get(review.id)?.focus();
  }

  // Focus the first (or the asked-for) row on open, or the dialog itself when the queue is empty.
  useEffect(() => {
    const review = reviews[active];
    if (review !== undefined) rowRefs.current.get(review.id)?.focus();
    else rootRef.current?.focus();
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

  const note = truncationNote(reviews.length, queue.total, queue.truncated);

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
      <div className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-3">
        <h2 id={titleId} className="text-sm font-semibold text-fg">
          Reviews waiting
        </h2>
        <CountBadge zero={!queue.loaded || queue.total === 0}>{queue.loaded ? queue.total : "…"}</CountBadge>
        <span className="ml-auto text-[11px] text-fg-muted">{note ?? "oldest first"}</span>
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
        <span className="ml-auto flex items-center gap-3">
          {showBoardLink && (
            <a href={formatRoute(BOARD_HOME)} onClick={openBoard} className="rounded text-xs text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
              Open the board
            </a>
          )}
          {onReviewAll !== undefined && (
            <button
              type="button"
              onClick={onReviewAll}
              disabled={reviews.length === 0}
              className="min-h-11 rounded-lg bg-accent px-3 text-xs font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50 sm:min-h-7"
            >
              Review all
            </button>
          )}
        </span>
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
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={active ? 0 : -1}
      aria-label={rowLabel(review, now)}
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
      {review.summaryLine !== null && <span className="mt-0.5 block truncate text-xs text-fg-muted">{review.summaryLine}</span>}
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
