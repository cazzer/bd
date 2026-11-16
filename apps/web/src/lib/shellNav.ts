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
 * Graph · Board · Roadmap · Inbox · Search. Each opens its view's home with
 * `carried` (the board with no saved view, the inbox on every source, an
 * empty search); the current view's link is the current address itself, so
 * activating it changes nothing. Feed, code and timeline have no link of
 * their own (the Views menu reaches them), so on them none is current.
 */
export function navLinks(route: Route, carried: readonly string[]): NavLink[] {
  return HOMES.map(({ id, label, route: home }) => {
    const current = id === route.view;
    return { id, label, current, route: current ? route : withProjects(home, carried) };
  });
}

/** The views `project` scopes; on every other one the switcher only changes the address. */
export function isProjectScoped(view: Route["view"]): boolean {
  return view === "board" || view === "roadmap" || view === "search";
}

const UNSCOPED_NAMES: Partial<Record<Route["view"], string>> = {
  graph: "The graph",
  feed: "This feed",
  code: "The code view",
  timeline: "The timeline",
  inbox: "The inbox",
};

/** The switcher's "not filtered here" hint on a view `project` does not scope; null on one it does. */
export function unfilteredHint(view: Route["view"]): string | null {
  const name = UNSCOPED_NAMES[view];
  return name === undefined ? null : `${name} is not filtered by project.`;
}

/** What the shell knows about projects (components/ShellProjects.tsx). */
export interface ShellProjects {
  /** The registry's keys, null until read (and while unreadable). */
  registry: string[] | null;
  registryFailed: boolean;
  /** The saved board view the address names, once read: its `project` predicate, or null when it names none or is not a board view. */
  boardView: { viewId: string; projects: string[] | null } | null;
}

/**
 * What the header's switcher offers on `route`: on a board drawn from a
 * saved view, that view's projects — unknown (the switcher disabled) until
 * the view is read — else every registered project, with the board's
 * fallback to the address's projects when the registry cannot be read
 * (`switcherOffer`).
 */
export function headerSwitcherOffer(route: Route, shell: ShellProjects): SwitcherOffer {
  let viewProjects: string[] | null = null;
  if (route.view === "board" && route.viewId !== null) {
    if (shell.boardView === null || shell.boardView.viewId !== route.viewId) return { offered: null, fallback: false };
    viewProjects = shell.boardView.projects;
  }
  return switcherOffer({ viewProjects, registry: shell.registry, registryFailed: shell.registryFailed, address: route.projects });
}
