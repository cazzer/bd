// The shell header (shared-nav-header, design.md decisions 1-3, 5, 8, 9):
// one bar App.tsx draws above every view, outside the memoized view, so a
// queue read re-renders it and never the view. Left to right: the project
// switcher; the nav links Graph · Board · Roadmap · Inbox · Search and the
// Views menu; then search, the hangar and relay status, and the review
// control.
//
// Project. Every link carries the reader's projects (lib/shellNav.ts
// `carriedProjects`); the switcher offers what lib/shellNav.ts
// `headerSwitcherOffer` says, from the registry the shell reads once
// (ShellProjects.tsx), and a choice is a history push of the same route with
// new projects (`chooseProject`, which drops the open item only on the board
// and roadmap). On a view `project` does not filter, the switcher says so.
//
// Size. The bar is `--header-h` tall (index.css) on every view and never
// wraps: from `HEADER_WIDE_QUERY` up everything is inline; below it the nav
// links and the Views menu collapse into one Menu disclosure, which also
// holds search and the status pills, leaving the switcher and the review
// control inline. The inline row needs about 1,250px with both status pills
// worded, hence 80rem rather than `sm`. Within it, the search box gives up
// width first (down to a 6rem input), then the status pills are clipped, so
// the review control at the end is never pushed out. The two layouts are
// chosen in script, not CSS, so each pill and search box is mounted once
// (each pill polls).
//
// Inert. While a drawer is a modal sheet (below ReviewDrawer's wide query)
// — the shell's queue drawer, or the board's or roadmap's own (`item` in
// the address) — the header is inert, as the views' own headers were.

import { useId } from "react";
import { navigate } from "../lib/navigate.js";
import { withProjects, type Route } from "../lib/route.js";
import { searchRouteFor } from "../lib/searchRow.js";
import { carriedProjects, headerSwitcherOffer, navLinks, unfilteredHint, type NavLink } from "../lib/shellNav.js";
import { useDisclosure } from "../lib/useDisclosure.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { chooseProject } from "../lib/workViewNav.js";
import { HangarStatusPill } from "./HangarStatusPill.js";
import { HeaderSearch } from "./HeaderSearch.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { RelayStatusPill } from "./RelayStatusPill.js";
import { useWideDrawer } from "./ReviewDrawer.js";
import { ReviewQueuePill, useShellDrawer } from "./ReviewQueue.js";
import { useShellProjects } from "./ShellProjects.js";
import { ShellLink } from "./ShellLink.js";
import { SavedViewsList, ViewsMenu } from "./ViewsMenu.js";

/** From this width up the header is one inline row; below it the nav and Views collapse into the Menu. */
export const HEADER_WIDE_QUERY = "(min-width: 80rem)";

const INLINE_LINK =
  "inline-flex h-7 items-center rounded-md px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent";
const INLINE_LINK_IDLE = "text-fg-muted hover:bg-surface-strong hover:text-fg";
const INLINE_LINK_CURRENT = "bg-accent/20 font-medium text-fg";

const MENU_ITEM = "flex min-h-11 items-center rounded-md px-2.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

export interface AppHeaderProps {
  route: Route;
}

export function AppHeader({ route }: AppHeaderProps) {
  const shell = useShellProjects();
  const wide = useMediaQuery(HEADER_WIDE_QUERY);
  const drawerWide = useWideDrawer();
  const { open: shellDrawerOpen } = useShellDrawer();
  const boardDrawerOpen = (route.view === "board" || route.view === "roadmap") && route.item !== null;

  const boardViewProjects = route.view === "board" && shell.boardView !== null && shell.boardView.viewId === route.viewId ? shell.boardView.projects : null;
  const carried = carriedProjects(route, boardViewProjects);
  const links = navLinks(route, carried);
  const { offered, fallback } = headerSwitcherOffer(route, shell);
  const switcherShown = fallback || offered?.length !== 0;

  function submitSearch(text: string) {
    const q = searchRouteFor(text).q;
    navigate(route.view === "search" ? { ...route, q } : withProjects(searchRouteFor(text), carried), "push");
  }
  const searchText = route.view === "search" ? (route.q ?? "") : "";

  return (
    <header inert={!drawerWide && (shellDrawerOpen || boardDrawerOpen)} className="relative z-30 h-[var(--header-h)] shrink-0 px-2 pt-2 sm:px-3 sm:pt-3">
      <div className="glass flex h-full min-w-0 items-center gap-1.5 px-2 sm:gap-3 sm:px-3">
        {switcherShown && (
          <ProjectSwitcher
            offered={offered}
            address={route.projects}
            fallback={fallback}
            hint={unfilteredHint(route.view)}
            onChoose={(choice) => offered && navigate(chooseProject(route, offered, choice), "push")}
          />
        )}
        {wide ? (
          <nav aria-label="Main" className="flex shrink-0 items-center gap-0.5">
            {links.map((link) => (
              <ShellLink key={link.id} route={link.route} current={link.current} className={`${INLINE_LINK} ${link.current ? INLINE_LINK_CURRENT : INLINE_LINK_IDLE}`}>
                {link.label}
              </ShellLink>
            ))}
            <ViewsMenu projects={carried} buttonClassName={`${INLINE_LINK} ${INLINE_LINK_IDLE}`} />
          </nav>
        ) : (
          <HeaderMenu links={links} projects={carried} searchText={searchText} onSearch={submitSearch} />
        )}
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2 text-xs text-fg-muted">
          {wide && (
            <>
              <div className="flex min-w-0 shrink-[4] [&_input]:min-w-24">
                <HeaderSearch initialText={searchText} onSubmit={submitSearch} />
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <HangarStatusPill />
                <RelayStatusPill />
              </div>
            </>
          )}
          {/* The review control's place (shared-nav-header task group 2 makes it the review control with the inbox count). */}
          <ReviewQueuePill />
        </div>
      </div>
    </header>
  );
}

interface HeaderMenuProps {
  links: NavLink[];
  projects: readonly string[];
  searchText: string;
  onSearch: (text: string) => void;
}

/** The narrow header's Menu: nav links, saved views, search and the status pills in one disclosure (design.md decision 8). */
function HeaderMenu({ links, projects, searchText, onSearch }: HeaderMenuProps) {
  const { open, toggle, close, buttonRef, panelRef } = useDisclosure();
  const panelId = useId();
  const viewsHeadingId = useId();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-hairline px-2.5 text-sm text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 text-fg-muted">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Menu
      </button>
      <div
        ref={(el) => {
          panelRef.current = el;
        }}
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-full z-40 mt-2 max-h-[calc(100dvh-var(--header-h)-1rem)] space-y-3 overflow-y-auto rounded-2xl border border-hairline bg-ground p-2 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.65)]"
      >
        <nav aria-label="Main">
          <ul>
            {links.map((link) => (
              <li key={link.id}>
                <ShellLink
                  route={link.route}
                  current={link.current}
                  onNavigate={() => close(true)}
                  className={`${MENU_ITEM} ${link.current ? "bg-accent/20 font-medium text-fg" : "text-fg hover:bg-surface-strong"}`}
                >
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
          <SavedViewsList active={open} projects={projects} onChoose={() => close(true)} />
        </section>
        <div className="space-y-2 border-t border-hairline px-1 pt-2">
          <HeaderSearch
            initialText={searchText}
            onSubmit={(text) => {
              onSearch(text);
              close(true);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <HangarStatusPill />
            <RelayStatusPill />
          </div>
        </div>
      </div>
    </>
  );
}
