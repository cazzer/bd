// The header's Views menu (shared-nav-header, design.md decision 5): the
// store's saved view nodes, grouped by renderer (lib/savedViews.ts), each a
// link that opens it in its renderer carrying the reader's projects. The
// saved view the address draws is marked current (`aria-current="page"`),
// and so is the trigger while one is.
//
// Read: `list` of `view` nodes, once, the first time any list is shown, and
// kept for the session — module state, so the wide menu and the collapsed
// Menu (which swap at a breakpoint) share it. A failed read is one line
// inside the menu, and is forgotten, so the next opening tries again; the
// rest of the header never waits on it. More views than one read holds are
// said to exist, not paged.
//
// Both panels sit inside the header's `glass` bar, whose backdrop-filter
// would be the only thing a blur of theirs could see, so they are opaque.
//
// `ViewsMenu` is the wide header's disclosure: a button (`aria-expanded`,
// `aria-controls`) over a panel of grouped links. ArrowDown on the button
// opens it on its first link, as on the review pill; ArrowUp/ArrowDown move
// between links; Escape closes it and returns focus to the button; a press
// outside, focus leaving, or a choice closes it. `SavedViewsList` is the
// list alone, which the collapsed Menu embeds.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { groupSavedViews, savedViewRoute, type SavedViewGroup } from "../lib/savedViews.js";
import { useDisclosure } from "../lib/useDisclosure.js";
import { trpc } from "../trpc.js";
import { ShellLink } from "./ShellLink.js";

/** More than any store holds today; `list`'s own cap is 500. */
export const SAVED_VIEWS_LIMIT = 200;

interface SavedViews {
  groups: SavedViewGroup[];
  /** More view nodes exist than this read holds. */
  hasMore: boolean;
}

type SavedViewsState = { kind: "loading" } | ({ kind: "ready" } & SavedViews) | { kind: "error"; message: string };

let savedViewsRead: Promise<SavedViews> | null = null;

function readSavedViews(): Promise<SavedViews> {
  if (savedViewsRead === null) {
    const read = trpc.list.query({ nodeTypes: ["view"], limit: SAVED_VIEWS_LIMIT }).then((page) => ({ groups: groupSavedViews(page.nodes), hasMore: page.hasMore }));
    read.catch(() => {
      if (savedViewsRead === read) savedViewsRead = null;
    });
    savedViewsRead = read;
  }
  return savedViewsRead;
}

/** Forget the session's read (tests start each case from nothing). */
export function forgetSavedViews(): void {
  savedViewsRead = null;
}

/** The saved views, read the first time `active` is true and kept after. */
function useSavedViews(active: boolean): SavedViewsState {
  const [state, setState] = useState<SavedViewsState>({ kind: "loading" });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    readSavedViews().then(
      (views) => {
        if (!cancelled) setState({ kind: "ready", ...views });
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "the read failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active]);
  return state;
}

/** ArrowUp/ArrowDown/Home/End between the links inside `container`; true when the key was one of those. */
export function moveBetweenLinks(container: HTMLElement | null, e: KeyboardEvent<HTMLElement>): boolean {
  if (container === null || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return false;
  const links = [...container.querySelectorAll<HTMLAnchorElement>("a[href]")];
  if (links.length === 0) return false;
  e.preventDefault();
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : e.key === "ArrowDown" ? (at + 1) % links.length : at <= 0 ? links.length - 1 : at - 1;
  links[next]!.focus();
  return true;
}

const ITEM = "flex items-center rounded-md px-2.5 focus:outline-none focus:ring-2 focus:ring-accent";
/** The wide menu's rows. */
export const VIEWS_MENU_ITEM = `${ITEM} min-h-11 py-1 text-sm sm:min-h-0 sm:text-xs`;
const IDLE = "text-fg hover:bg-surface-strong";
const CURRENT = "bg-accent/20 font-medium text-fg";

export interface SavedViewsListProps {
  /** Read on the first render where this is true. */
  active: boolean;
  /** Carried by every link. */
  projects: readonly string[];
  /** The saved view the address draws, marked current. */
  currentViewId: string | null;
  /** Each row's size and type (state colours are added). */
  itemClassName?: string;
  /** Focus the first link once the list is ready (opened from the keyboard). */
  focusFirst?: boolean;
  onFocusedFirst?: () => void;
  onChoose: () => void;
}

export function SavedViewsList({ active, projects, currentViewId, itemClassName = VIEWS_MENU_ITEM, focusFirst = false, onFocusedFirst, onChoose }: SavedViewsListProps) {
  const state = useSavedViews(active);
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusFirst || state.kind === "loading") return;
    rootRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
    onFocusedFirst?.();
  }, [focusFirst, state.kind, onFocusedFirst]);

  if (state.kind === "loading") return <p className="px-2.5 py-1 text-xs text-fg-muted">Loading views…</p>;
  if (state.kind === "error") {
    return (
      <p role="alert" className="px-2.5 py-1 text-xs text-red-300">
        Couldn't read the saved views: {state.message}
      </p>
    );
  }
  if (state.groups.length === 0) return <p className="px-2.5 py-1 text-xs text-fg-muted">No saved views yet.</p>;
  return (
    <div ref={rootRef} className="space-y-2">
      {state.groups.map((group) => (
        <section key={group.renderer} aria-labelledby={`${headingId}-${group.renderer}`}>
          <h3 id={`${headingId}-${group.renderer}`} className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
            {group.label}
          </h3>
          <ul>
            {group.views.map((view) => {
              const current = view.id === currentViewId;
              return (
                <li key={view.id}>
                  <ShellLink route={savedViewRoute(group.renderer, view.id, projects)} current={current} onNavigate={onChoose} className={`${itemClassName} ${current ? CURRENT : IDLE}`}>
                    <span className="truncate">{view.title}</span>
                  </ShellLink>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {state.hasMore && <p className="px-2.5 pt-1 text-[11px] text-fg-muted">More views not listed.</p>}
    </div>
  );
}

export interface ViewsMenuProps {
  projects: readonly string[];
  currentViewId: string | null;
  /** The trigger's classes, idle and while a saved view is current, so it matches the nav links beside it. */
  buttonClassName: string;
  currentButtonClassName: string;
}

export function ViewsMenu({ projects, currentViewId, buttonClassName, currentButtonClassName }: ViewsMenuProps) {
  const { open, toggle, show, close, buttonRef, panelRef } = useDisclosure();
  const panelId = useId();
  const [focusFirst, setFocusFirst] = useState(false);
  const current = currentViewId !== null;

  function onButtonKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (open) panelRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
    else {
      show();
      setFocusFirst(true);
    }
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-description={current ? "A saved view is open" : undefined}
        onClick={toggle}
        onKeyDown={onButtonKeyDown}
        className={`${current ? currentButtonClassName : buttonClassName} gap-1`}
      >
        Views
        <svg aria-hidden="true" viewBox="0 0 12 12" className={`h-3 w-3 text-fg-muted motion-safe:transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        ref={(el) => {
          panelRef.current = el;
        }}
        id={panelId}
        hidden={!open}
        onKeyDown={(e) => moveBetweenLinks(panelRef.current, e)}
        className="absolute top-full left-0 z-40 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-hairline bg-ground p-2 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]"
      >
        <SavedViewsList active={open} projects={projects} currentViewId={currentViewId} focusFirst={focusFirst} onFocusedFirst={() => setFocusFirst(false)} onChoose={() => close(true)} />
      </div>
    </div>
  );
}
