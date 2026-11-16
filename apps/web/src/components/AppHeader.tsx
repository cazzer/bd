// The shell header (shared-nav-header, design.md decisions 1-3, 5, 8, 9):
// one bar App.tsx draws above every view, outside the memoized view, so a
// queue read re-renders it and never the view. Left to right: the project
// switcher; the nav links Graph · Board · Roadmap · Inbox · Search and the
// Views menu; then search, the hangar and relay status, and the review
// control.
//
// Project. Every link carries the reader's projects (lib/shellNav.ts
// `carriedProjects`); the switcher offers what lib/shellNav.ts
// `headerSwitcherOffer` says, from the registry the shell reads
// (ShellProjects.tsx), and a choice is a history push of the same route with
// new projects (`chooseProject`, which drops the open item only on the board
// and roadmap). On a view `project` does not filter, the switcher is drawn
// dashed and muted, says so in its tooltip and description, and carries an
// "unfiltered" tag inside its box (from `sm`; below, the Menu's first line
// says it). While the registry is empty the switcher's width is held, so
// the nav does not move when it loads.
//
// Current place. The current nav link is marked; on a saved view (feed,
// code, timeline, or a board drawn from a view) the Views trigger is styled
// current and the view's row is marked inside it, and Board opens the plain
// board.
//
// Size. The header is a normal-flow bar `--header-h` tall (index.css) on
// every view; it never wraps. Its contents follow four width tiers, chosen
// in script (`headerTier`) so each control is mounted once:
// - wide (80rem up): everything inline, search as a box (on the graph, the
//   mid tier's magnifier: the graph's floating bar is its box), status pills and
//   the review pill worded — unless worded they would be clipped, when they
//   go compact until the bar is wider than it was then (`useClipFallback`);
// - mid (56rem up): nav and Views inline; search behind a magnifier button
//   (a popover holding the box); status pills compact (dot and one count)
//   and the review pill without its state word ("1 review");
// - narrow (40rem up): nav, Views and search collapse into one Menu
//   disclosure labelled with the current place; compact pills stay inline
//   and the review pill shows bare numbers;
// - phone: the same Menu, which also holds the status pills — the Menu
//   button then carries a warning dot while hangar or the relay shows
//   offline, so status is never hidden behind a closed disclosure unflagged.
//   The switcher sizes to its content there and the Menu button takes the
//   rest of the row, so the current place's name is cut only when it must be.
// Below the wide tier the search view puts its own box in its toolbar
// (SearchView.tsx), so /search always shows an editable query.
// Within a row the search box gives up width first, then the status pills
// are clipped, so the review control at the end is never pushed out. On
// wide and mid, when even the compact status pills are clipped, the review
// pill goes to bare numbers too, by the same rule.
//
// Status. The header polls hangar and the relay once (`useHangarStatus`,
// `useRelayStatus`) and draws the chips wherever the tier puts them.
//
// Review control. The review pill with the inbox count beside it (design.md
// decision 6): the header polls the inbox's pending items itself
// (lib/useInboxCount.ts), and hands the pill its popover's footer routes —
// the board and the inbox's Needs me with the projects every header link
// carries. How worded the pill is follows the tiers above.
//
// Stacking. Above a drawer (z-[45] over the drawers' z-40, under the
// portalled queue popover's z-50), so a menu panel is never covered by one;
// while a drawer is a modal sheet (below ReviewDrawer's wide query) — the
// shell's queue drawer, or the board's or roadmap's own (`item` in the
// address) — the header is inert and drops under it.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { BOARD_HOME, INBOX_HOME } from "../lib/reviewQueueRow.js";
import { withProjects, type Route } from "../lib/route.js";
import { searchRouteFor } from "../lib/searchRow.js";
import { boardViewProjects, carriedProjects, currentPlace, currentSavedViewId, headerSwitcherOffer, navLinks, shownView, unfilteredHint, type NavLink } from "../lib/shellNav.js";
import { useDisclosure } from "../lib/useDisclosure.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { useInboxCount } from "../lib/useInboxCount.js";
import { useRelayStatus, type PolledRelayStatus } from "../lib/useRelayStatus.js";
import { chooseProject } from "../lib/workViewNav.js";
import { HangarStatusChip, hangarShownOffline, useHangarStatus, type PolledHangarStatus } from "./HangarStatusPill.js";
import { HeaderSearch } from "./HeaderSearch.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { RelayStatusChip, relayShownOffline } from "./RelayStatusPill.js";
import { useWideDrawer } from "./ReviewDrawer.js";
import { ReviewQueuePill, useShellDrawer } from "./ReviewQueue.js";
import { useShellProjects } from "./ShellProjects.js";
import { ShellLink } from "./ShellLink.js";
import { moveBetweenLinks, SavedViewsList, ViewsMenu } from "./ViewsMenu.js";

/** The width tiers' lower bounds (see the header comment). */
export const HEADER_WIDE_QUERY = "(min-width: 80rem)";
export const HEADER_MID_QUERY = "(min-width: 56rem)";
export const HEADER_NARROW_QUERY = "(min-width: 40rem)";

export type HeaderTier = "wide" | "mid" | "narrow" | "phone";

type ElementRef = { current: HTMLElement | null };

/** The bar's width, kept current. */
function useBarWidth(bar: ElementRef): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [bar]);
  return width;
}

/**
 * Whether the header must fall back to fewer words although the tier
 * `tries` them: true when it does not try, and once `chips` was clipped
 * (its box narrower than its content) while `measuring`, until the bar is
 * wider than it was when that happened.
 */
function useClipFallback(tries: boolean, measuring: boolean, barWidth: number, bar: ElementRef, chips: ElementRef): boolean {
  const [clippedAt, setClippedAt] = useState<number | null>(null);
  const fallback = !tries || (clippedAt !== null && barWidth <= clippedAt);

  // Every render: content changes (a count growing) can clip the words at an unchanged width.
  useLayoutEffect(() => {
    const el = chips.current;
    if (fallback || !measuring || el === null || el.scrollWidth <= el.clientWidth) return;
    setClippedAt(bar.current?.clientWidth ?? barWidth);
  });

  return fallback;
}

function useHeaderTier(): HeaderTier {
  const wide = useMediaQuery(HEADER_WIDE_QUERY);
  const mid = useMediaQuery(HEADER_MID_QUERY);
  const narrow = useMediaQuery(HEADER_NARROW_QUERY);
  return wide ? "wide" : mid ? "mid" : narrow ? "narrow" : "phone";
}

const INLINE_LINK = "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent";
const INLINE_LINK_IDLE = "text-fg-muted hover:bg-surface-strong hover:text-fg";
const INLINE_LINK_CURRENT = "bg-accent/20 font-medium text-fg";

/** One row style for everything inside the collapsed Menu. */
const MENU_ITEM = "flex min-h-11 items-center rounded-md px-2.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const MENU_ITEM_IDLE = "text-fg hover:bg-surface-strong";
const MENU_ITEM_CURRENT = "bg-accent/20 font-medium text-fg";

/** A small header button the size of the other controls (44px where the pointer is coarse). */
const SMALL_BUTTON =
  "inline-flex h-7 items-center justify-center rounded-lg border border-hairline text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent pointer-coarse:h-auto pointer-coarse:min-h-11";

const PANEL = "rounded-2xl border border-hairline bg-ground p-2 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]";

export interface AppHeaderProps {
  route: Route;
}

export function AppHeader({ route }: AppHeaderProps) {
  const shell = useShellProjects();
  const tier = useHeaderTier();
  const drawerWide = useWideDrawer();
  const { open: shellDrawerOpen } = useShellDrawer();
  const hangar = useHangarStatus();
  const relay = useRelayStatus();
  const inboxCount = useInboxCount();
  const boardDrawerOpen = (route.view === "board" || route.view === "roadmap") && route.item !== null;
  const inert = !drawerWide && (shellDrawerOpen || boardDrawerOpen);

  const carried = carriedProjects(route, boardViewProjects(route, shell));
  const links = navLinks(route, carried);
  const savedViewId = currentSavedViewId(route);
  const { offered, fallback } = headerSwitcherOffer(route, shell);
  const switcherShown = fallback || offered?.length !== 0;
  const hint = unfilteredHint(route.view);

  function submitSearch(text: string) {
    const q = searchRouteFor(text).q;
    navigate(route.view === "search" ? { ...route, q } : withProjects(searchRouteFor(text), carried), "push");
  }
  const searchText = route.view === "search" ? (route.q ?? "") : "";
  const collapsed = tier === "narrow" || tier === "phone";
  // The graph's own floating bar is its search box, so there the wide tier's box is the mid tier's magnifier too.
  const searchBox = tier === "wide" && route.view !== "graph";
  const searchButton = tier === "mid" || (tier === "wide" && route.view === "graph");
  const barRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const barWidth = useBarWidth(barRef);
  // The status pills lose their words first; the review pill then loses its count words while the compact status pills are still clipped.
  const compact = useClipFallback(tier === "wide", true, barWidth, barRef, chipsRef);
  const reviewBare = useClipFallback(tier === "wide" || tier === "mid", compact, barWidth, barRef, chipsRef);

  return (
    <header inert={inert} className={`relative h-[var(--header-h)] shrink-0 px-2 pt-2 sm:px-3 sm:pt-3 ${inert ? "z-30" : "z-[45]"}`}>
      <div ref={barRef} className="glass flex h-full min-w-0 items-center gap-1.5 px-2 sm:gap-3 sm:px-3">
        <div className="flex shrink-0 items-center" onFocus={shell.retryRegistry}>
          {switcherShown ? (
            <ProjectSwitcher offered={offered} address={route.projects} fallback={fallback} hint={hint} onChoose={(choice) => offered && navigate(chooseProject(route, offered, choice), "push")} />
          ) : (
            <span aria-hidden="true" className="w-36 shrink-0 sm:w-44" />
          )}
        </div>
        {collapsed ? (
          <HeaderMenu
            links={links}
            projects={carried}
            currentViewId={savedViewId}
            place={currentPlace(route, shownView(route, shell)?.title ?? null)}
            unfilteredLine={tier === "phone" && switcherShown ? hint : null}
            searchText={searchText}
            onSearch={submitSearch}
            status={tier === "phone" ? { hangar, relay } : null}
          />
        ) : (
          <nav aria-label="Main" className="flex shrink-0 items-center gap-0.5">
            {links.map((link) => (
              <ShellLink key={link.id} route={link.route} current={link.current} className={`${INLINE_LINK} ${link.current ? INLINE_LINK_CURRENT : INLINE_LINK_IDLE}`}>
                {link.label}
              </ShellLink>
            ))}
            <ViewsMenu projects={carried} currentViewId={savedViewId} buttonClassName={`${INLINE_LINK} ${INLINE_LINK_IDLE}`} currentButtonClassName={`${INLINE_LINK} ${INLINE_LINK_CURRENT}`} />
          </nav>
        )}
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2 text-xs text-fg-muted">
          {searchBox && (
            <div className="flex min-w-0 shrink-[4] [&_input]:min-w-24">
              <HeaderSearch initialText={searchText} onSubmit={submitSearch} />
            </div>
          )}
          {searchButton && <SearchPopover initialText={searchText} onSearch={submitSearch} />}
          {tier !== "phone" && (
            <div ref={chipsRef} className="flex min-w-0 items-center gap-2 overflow-hidden">
              <HangarStatusChip polled={hangar} compact={compact} />
              <RelayStatusChip polled={relay} compact={compact} />
            </div>
          )}
          <ReviewQueuePill compact={compact} bare={reviewBare} inboxCount={inboxCount} inboxRoute={withProjects(INBOX_HOME, carried)} boardRoute={withProjects(BOARD_HOME, carried)} />
        </div>
      </div>
    </header>
  );
}

function MagnifierIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 text-fg-muted">
      <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.25 10.25 3.25 3.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The mid tier's search: a magnifier button over a small popover holding the search box, focused. */
function SearchPopover({ initialText, onSearch }: { initialText: string; onSearch: (text: string) => void }) {
  const { open, toggle, close, buttonRef, panelRef } = useDisclosure();
  const panelId = useId();
  return (
    <div className="relative shrink-0">
      <button ref={buttonRef} type="button" aria-label="Search everything" aria-expanded={open} aria-controls={panelId} onClick={toggle} className={`${SMALL_BUTTON} w-7 shrink-0 pointer-coarse:w-11`}>
        <MagnifierIcon />
      </button>
      <div
        ref={(el) => {
          panelRef.current = el;
        }}
        id={panelId}
        hidden={!open}
        className={`absolute top-full right-0 z-40 mt-2 w-80 ${PANEL}`}
      >
        {open && (
          <HeaderSearch
            initialText={initialText}
            fill
            autoFocus
            onSubmit={(text) => {
              onSearch(text);
              close(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

interface HeaderMenuProps {
  links: NavLink[];
  projects: readonly string[];
  currentViewId: string | null;
  /** What the button names as where the reader is. */
  place: string;
  /** Said at the top of the panel on a view the project does not filter (phone, where the marker is not drawn). */
  unfilteredLine: string | null;
  searchText: string;
  onSearch: (text: string) => void;
  /** The status chips, when the Menu holds them (phone). */
  status: { hangar: PolledHangarStatus | null; relay: PolledRelayStatus | null } | null;
}

/** The collapsed header's Menu: nav links, saved views, search (and on a phone the status pills) in one disclosure (design.md decision 8). */
function HeaderMenu({ links, projects, currentViewId, place, unfilteredLine, searchText, onSearch, status }: HeaderMenuProps) {
  const { open, toggle, show, close, buttonRef, panelRef } = useDisclosure();
  const panelId = useId();
  const viewsHeadingId = useId();
  const [focusFirst, setFocusFirst] = useState(false);
  const warning = status !== null && (hangarShownOffline(status.hangar) || relayShownOffline(status.relay));

  useEffect(() => {
    if (!open || !focusFirst) return;
    panelRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
    setFocusFirst(false);
  }, [open, focusFirst, panelRef]);

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
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Views and navigation, current: ${place}${warning ? " (a status is offline)" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={onButtonKeyDown}
        className={`${SMALL_BUTTON} relative min-w-0 gap-1 px-2.5 text-xs max-sm:flex-1 max-sm:justify-between pointer-coarse:text-sm`}
      >
        <span className="min-w-0 truncate sm:max-w-[10rem]">{place}</span>
        <svg aria-hidden="true" viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 text-fg-muted motion-safe:transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {warning && <span aria-hidden="true" data-menu-warning="" className="absolute -top-1 -right-1 size-2.5 rounded-full border-[1.5px] border-ground bg-red-400" />}
      </button>
      <div
        ref={(el) => {
          panelRef.current = el;
        }}
        id={panelId}
        hidden={!open}
        onKeyDown={(e) => moveBetweenLinks(panelRef.current, e)}
        className={`absolute inset-x-0 top-full z-40 mt-2 max-h-[calc(100dvh-var(--header-h)-1rem)] space-y-3 overflow-y-auto ${PANEL}`}
      >
        {unfilteredLine !== null && <p className="px-2.5 pt-1 text-xs text-fg-muted">{unfilteredLine}</p>}
        <nav aria-label="Main">
          <ul>
            {links.map((link) => (
              <li key={link.id}>
                <ShellLink route={link.route} current={link.current} onNavigate={() => close(true)} className={`${MENU_ITEM} ${link.current ? MENU_ITEM_CURRENT : MENU_ITEM_IDLE}`}>
                  {link.label}
                </ShellLink>
              </li>
            ))}
          </ul>
        </nav>
        <section aria-labelledby={viewsHeadingId} className="border-t border-hairline pt-2">
          <h2 id={viewsHeadingId} className="px-2.5 pb-1 text-xs font-semibold text-fg">
            Views
          </h2>
          <SavedViewsList active={open} projects={projects} currentViewId={currentViewId} itemClassName={MENU_ITEM} onChoose={() => close(true)} />
        </section>
        <div className="space-y-2 border-t border-hairline px-1 pt-2">
          <HeaderSearch
            initialText={searchText}
            fill
            onSubmit={(text) => {
              onSearch(text);
              close(true);
            }}
          />
          {status !== null && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <HangarStatusChip polled={status.hangar} />
              <RelayStatusChip polled={status.relay} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
