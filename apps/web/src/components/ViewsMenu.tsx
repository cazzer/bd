// The header's Views menu (shared-nav-header, design.md decision 5): the
// store's saved view nodes, grouped by renderer (lib/savedViews.ts), each a
// link that opens it in its renderer carrying the reader's projects.
//
// Read: `list` of `view` nodes, once, the first time any list is shown, and
// kept for the session — module state, so the wide menu and the phone Menu
// (which swap at the breakpoint) share it. A failed read is one line inside
// the menu, and is forgotten, so the next opening tries again; the rest of
// the header never waits on it.
//
// Both panels sit inside the header's `glass` bar, whose backdrop-filter
// would be the only thing a blur of theirs could see, so they are opaque.
//
// `ViewsMenu` is the wide header's disclosure: a button (`aria-expanded`,
// `aria-controls`) over a panel of grouped links; Escape closes it and
// returns focus to the button, a press outside closes it, and a choice
// closes it. `SavedViewsList` is the list alone, which the phone Menu
// embeds.

import { useEffect, useId, useState } from "react";
import { groupSavedViews, savedViewRoute, type SavedViewGroup } from "../lib/savedViews.js";
import { useDisclosure } from "../lib/useDisclosure.js";
import { trpc } from "../trpc.js";
import { ShellLink } from "./ShellLink.js";

/** More than any store holds today; `list`'s own cap is 500. */
export const SAVED_VIEWS_LIMIT = 200;

type SavedViewsState = { kind: "loading" } | { kind: "ready"; groups: SavedViewGroup[] } | { kind: "error"; message: string };

let savedViewsRead: Promise<SavedViewGroup[]> | null = null;

function readSavedViews(): Promise<SavedViewGroup[]> {
  if (savedViewsRead === null) {
    const read = trpc.list.query({ nodeTypes: ["view"], limit: SAVED_VIEWS_LIMIT }).then((page) => groupSavedViews(page.nodes));
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
      (groups) => {
        if (!cancelled) setState({ kind: "ready", groups });
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

const ITEM =
  "flex min-h-11 items-center rounded-md px-2.5 py-1 text-sm text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 sm:text-xs";

export interface SavedViewsListProps {
  /** Read on the first render where this is true. */
  active: boolean;
  /** Carried by every link. */
  projects: readonly string[];
  onChoose: () => void;
}

export function SavedViewsList({ active, projects, onChoose }: SavedViewsListProps) {
  const state = useSavedViews(active);
  const headingId = useId();
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
    <div className="space-y-2">
      {state.groups.map((group) => (
        <section key={group.renderer} aria-labelledby={`${headingId}-${group.renderer}`}>
          <h3 id={`${headingId}-${group.renderer}`} className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
            {group.label}
          </h3>
          <ul>
            {group.views.map((view) => (
              <li key={view.id}>
                <ShellLink route={savedViewRoute(group.renderer, view.id, projects)} onNavigate={onChoose} className={ITEM}>
                  <span className="truncate">{view.title}</span>
                </ShellLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export interface ViewsMenuProps {
  projects: readonly string[];
  /** The trigger's classes, so it matches the nav links beside it. */
  buttonClassName: string;
}

export function ViewsMenu({ projects, buttonClassName }: ViewsMenuProps) {
  const { open, toggle, close, buttonRef, panelRef } = useDisclosure();
  const panelId = useId();

  return (
    <div className="relative">
      <button ref={buttonRef} type="button" aria-expanded={open} aria-controls={panelId} onClick={toggle} className={`${buttonClassName} gap-1`}>
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
        className="absolute top-full left-0 z-40 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-hairline bg-ground p-2 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]"
      >
        <SavedViewsList active={open} projects={projects} onChoose={() => close(true)} />
      </div>
    </div>
  );
}
