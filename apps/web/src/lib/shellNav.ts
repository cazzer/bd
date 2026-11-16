// The shell header's navigation, as pure functions (shared-nav-header,
// design.md decisions 2-4): which projects follow the reader out of the
// current route, the five nav links and which one is current, what the
// header's project switcher offers, and the hint it carries on a view that
// is not filtered by project. components/AppHeader.tsx owns when; this
// module owns what.

import { viewCarriedProjects, switcherOffer, type SwitcherOffer } from "./workViewNav.js";
import { withProjects, type Route } from "./route.js";

export type NavId = "graph" | "board" | "roadmap" | "inbox" | "search";

export interface NavLink {
  id: NavId;
  label: string;
  route: Route;
  current: boolean;
}

/**
 * The projects every header link carries. The address's own, except on a
 * board drawn from a saved view that names projects while the address
 * names none: that board shows the view's projects, not every registered
 * one, so those are what follow the reader (the old Board → Roadmap
 * toggle's rule, `viewCarriedProjects`, applied to every link).
 * `boardViewProjects` is that view's `project` predicate, or null when the
 * view names none or is not known yet.
 */
export function carriedProjects(route: Route, boardViewProjects: readonly string[] | null): string[] {
  if (route.view === "board" && route.viewId !== null && route.projects.length === 0) {
    const carried = viewCarriedProjects(boardViewProjects, route.projects);
    if (carried !== null) return carried;
  }
  return [...route.projects];
}

const HOMES: ReadonlyArray<{ id: NavId; label: string; route: Route }> = [
  { id: "graph", label: "Graph", route: { view: "graph", q: null, types: [], node: null, projects: [] } },
  { id: "board", label: "Board", route: { view: "board", viewId: null, projects: [], item: null } },
  { id: "roadmap", label: "Roadmap", route: { view: "roadmap", projects: [], item: null } },
  { id: "inbox", label: "Inbox", route: { view: "inbox", item: null, projects: [] } },
  { id: "search", label: "Search", route: { view: "search", q: null, types: [], projects: [], reviewsOnly: false } },
];

/**
 * The saved view the route draws: its `view` id on feed, code, timeline,
 * and a board drawn from one; null everywhere else (the plain board
 * included). The Views menu marks it current.
 */
export function currentSavedViewId(route: Route): string | null {
  switch (route.view) {
    case "feed":
    case "code":
    case "timeline":
    case "board":
      return route.viewId;
    default:
      return null;
  }
}

/**
 * Graph · Board · Roadmap · Inbox · Search. Each opens its view's home with
 * `carried` (the plain board with no saved view, the inbox on every source,
 * an empty search); the current view's link is the current address itself,
 * so activating it changes nothing. A saved view — a feed, code view,
 * timeline, or a board drawn from a view — has no link of its own (the
 * Views menu marks it), so on one none is current, and Board opens the
 * plain board.
 */
export function navLinks(route: Route, carried: readonly string[]): NavLink[] {
  const onSavedView = currentSavedViewId(route) !== null;
  return HOMES.map(({ id, label, route: home }) => {
    const current = id === route.view && !onSavedView;
    return { id, label, current, route: current ? route : withProjects(home, carried) };
  });
}

const RENDERER_NAMES: Partial<Record<Route["view"], string>> = { feed: "Feed", code: "Code", timeline: "Timeline", board: "Board" };

/**
 * Where the reader is, for the collapsed Menu's label: the current nav
 * link's label, else the saved view's title once known (`viewTitle`), else
 * its renderer's name.
 */
export function currentPlace(route: Route, viewTitle: string | null): string {
  if (currentSavedViewId(route) !== null) return viewTitle !== null && viewTitle.trim() !== "" ? viewTitle : (RENDERER_NAMES[route.view] ?? "View");
  return HOMES.find((h) => h.id === route.view)?.label ?? RENDERER_NAMES[route.view] ?? "View";
}

/**
 * For every view, what the switcher's hint calls it when `project` does not
 * filter it — or null for the views it scopes (board, roadmap, search). The
 * one source for both `isProjectScoped` and `unfilteredHint`.
 */
const UNFILTERED_NAME: Record<Route["view"], string | null> = {
  graph: "The graph",
  feed: "This feed",
  code: "The code view",
  timeline: "The timeline",
  inbox: "The inbox",
  board: null,
  roadmap: null,
  search: null,
};

/** The views `project` scopes; on every other one the switcher only changes the address. */
export function isProjectScoped(view: Route["view"]): boolean {
  return UNFILTERED_NAME[view] === null;
}

/** The switcher's "not filtered here" hint on a view `project` does not scope; null on one it does. */
export function unfilteredHint(view: Route["view"]): string | null {
  const name = UNFILTERED_NAME[view];
  return name === null ? null : `${name} isn't filtered by project.`;
}

/** The saved view the address names, once read (components/ShellProjects.tsx). */
export interface ShellView {
  viewId: string;
  /** Its title; null when it could not be read or is not a view. */
  title: string | null;
  /** `metadata.renderer`; null when it could not be read or is not a view. */
  renderer: string | null;
  /** Its filter's `project` predicate; null when it names none or could not be read. */
  projects: string[] | null;
}

/** What the shell knows about projects and the current saved view (components/ShellProjects.tsx). */
export interface ShellProjects {
  /** The registry's keys, null until read (and while unreadable). */
  registry: string[] | null;
  registryFailed: boolean;
  /** The saved view the address names, once read; null before that or with none named. */
  view: ShellView | null;
}

/** The current route's saved view as read, or null while it is not (or none is named). */
export function shownView(route: Route, shell: ShellProjects): ShellView | null {
  const id = currentSavedViewId(route);
  return id !== null && shell.view !== null && shell.view.viewId === id ? shell.view : null;
}

/** A saved board view's own projects, when the route is a board drawn from one that names some. */
export function boardViewProjects(route: Route, shell: ShellProjects): string[] | null {
  const view = route.view === "board" ? shownView(route, shell) : null;
  return view !== null && view.renderer === "board" ? view.projects : null;
}

/**
 * What the header's switcher offers on `route`: on a board drawn from a
 * saved view, that view's projects — unknown (the switcher disabled) until
 * the view is read — else every registered project, with the board's
 * fallback to the address's projects when the registry cannot be read
 * (`switcherOffer`).
 */
export function headerSwitcherOffer(route: Route, shell: ShellProjects): SwitcherOffer {
  if (route.view === "board" && route.viewId !== null && shownView(route, shell) === null) return { offered: null, fallback: false };
  return switcherOffer({ viewProjects: boardViewProjects(route, shell), registry: shell.registry, registryFailed: shell.registryFailed, address: route.projects });
}
