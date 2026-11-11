// The explorer's URL, as a pure parse/format pair (url-addressable-views,
// design.md decision 1). One place knows the URL's shape; the app shell
// (App.tsx) and each view own WHEN it is read and written (design.md
// decisions 2-5; node-views design.md decision 4), never how it is
// spelled.
//
// `Route` is a discriminated union on `view`: the graph view, — node-
// views, design.md decision 5 — the feed view, — code-view, design.md
// decision 2 — the code view, and — timeline-view, design.md decision 4 —
// the timeline view. Another way of looking at the same items is added by
// widening the union and teaching `parseRoute`/`formatRoute` its name;
// nothing about the existing views has to move, which is exactly what
// adding the feed proved and the code view and the timeline repeated.
//
// Not a router: four views with a handful of query parameters need no
// matching, layouts, or loaders, and a parse/format pair is a plain
// function with a plain test in the node environment, the same pattern
// every other `src/lib` module follows. Accordingly, this module never
// touches `window`, `location`, or `history` — callers hand it the
// strings (lib/navigate.ts is the one place that does touch them).
//
// Parsing never throws and validates nothing beyond shape: a `node` (or
// a feed's, the code view's, or the timeline's `view`) that is not a
// UUID, or names no node, is the server's to reject — `getNodes`'s
// `notFoundIds` is how GraphView.tsx discovers a bad id, and a format
// check here would be a second, weaker copy of that rule.

/** The graph view's path. `parseRoute` also accepts it with one trailing slash. */
export const GRAPH_VIEW_PATH = "/graph";

/** The feed view's path (node-views). `parseRoute` also accepts it with one trailing slash. */
export const FEED_VIEW_PATH = "/feed";

/** The code view's path (code-view). `parseRoute` also accepts it with one trailing slash. */
export const CODE_VIEW_PATH = "/code";

/** The timeline view's path (timeline-view). `parseRoute` also accepts it with one trailing slash. */
export const TIMELINE_VIEW_PATH = "/timeline";

/** The board view's path (live-beads-board). `parseRoute` also accepts it with one trailing slash. */
export const BOARD_VIEW_PATH = "/board";

/** The inbox view (inbox.ts in core). `parseRoute` also accepts it with one trailing slash. */
export const INBOX_VIEW_PATH = "/inbox";

/** The force-graph view: the submitted query, the node-type filters it was submitted with, and the selected node. `null`/`[]` mean absent. */
export interface GraphRoute {
  view: "graph";
  q: string | null;
  types: string[];
  node: string | null;
}

/** The feed view (node-views, design.md decision 5): the id of the `view` node whose filter it draws, or `null` when the address names none — FeedView's "no view" empty state, never a redirect. */
export interface FeedRoute {
  view: "feed";
  viewId: string | null;
}

/**
 * The code view (code-view, design.md decision 2): the id of the `view`
 * node whose roots it draws as a tree, and optionally the id of a node
 * within that tree to show — the selected file or directory. `null` for
 * either means absent: no view is CodeView's "no view" empty state, never
 * a redirect; no node is the tree with nothing chosen.
 */
export interface CodeRoute {
  view: "code";
  viewId: string | null;
  node: string | null;
}

/**
 * The timeline view (timeline-view, design.md decision 4): the id of the
 * `view` node whose filter names the chips, the id of the anchor whose
 * timed neighbours are listed, and the chosen node types — repeated `type`
 * parameters, exactly the graph's, so one parser rule serves both. `null`
 * for either id means absent: no view is TimelineView's "no view" empty
 * state and no anchor its "choose a node in the graph" state, never a
 * redirect; an empty `types` means every chip the view names is chosen
 * (and `NO_TYPE_CHOSEN` in lib/timelineRow.ts is how none chosen is
 * spelled, since an empty list cannot be).
 */
export interface TimelineRoute {
  view: "timeline";
  viewId: string | null;
  node: string | null;
  types: string[];
}

/**
 * The board view (live-beads-board, design.md decision 7): the id of the
 * `view` node whose renderer must be `board`, the chosen project keys as
 * repeated `project` parameters, in the order given, and the external id
 * (a bead id) of the item whose drawer is open (board-visual-reviews,
 * design.md decision 2). `null` for the view is a board of every
 * registered project (board-visual-reviews, design.md decision 3), never a
 * redirect; an empty `projects` means every project the view offers is
 * chosen, the way the timeline's empty `types` does; `null` for the item
 * means no drawer is open.
 */
export interface BoardRoute {
  view: "board";
  viewId: string | null;
  projects: string[];
  item: string | null;
}

/**
 * The inbox: the selected item — an inbox item's id, or `<project>/<bead>`
 * for a board review listed in Needs me — or `null` for the first one; and
 * the source filter (`review`, or an inbox source such as `gmail`), or
 * `null` for all (unify-review-queues).
 */
export interface InboxRoute {
  view: "inbox";
  item: string | null;
  source?: string | null;
}

/** Every addressable view. A future view widens this union. */
export type Route = GraphRoute | FeedRoute | CodeRoute | TimelineRoute | BoardRoute | InboxRoute;

/** `s` trimmed, or `null` when it is missing or whitespace-only — mirrors `runSearch`'s own trim, so `?q=%20` and no `q` at all mean the same thing. */
function nonEmpty(s: string | null): string | null {
  if (s === null) {
    return null;
  }
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The graph view's parameters from a query string alone, the path
 * ignored. `parseRoute` uses this for `/graph`; App.tsx uses it directly
 * for the unknown-path redirect (design.md decision 5), so `/?q=x` and
 * `/list?q=x` both carry their parameters to `/graph?q=x` rather than
 * losing them. Unknown parameters are ignored (and so dropped by the
 * first `formatRoute` write). Empty `q`/`node` become `null`; empty
 * `type` values are dropped; duplicate `type` values collapse to their
 * first occurrence, order otherwise preserved — the "Malformed
 * parameters degrade to defaults" scenario.
 */
export function graphRouteFromSearch(search: string): GraphRoute {
  const params = new URLSearchParams(search);
  return { view: "graph", q: nonEmpty(params.get("q")), types: typesFrom(params), node: nonEmpty(params.get("node")) };
}

/** Every `type` parameter, trimmed, empties dropped, duplicates collapsed to their first occurrence, order otherwise kept — the graph's rule, which the timeline shares. */
function typesFrom(params: URLSearchParams): string[] {
  const types: string[] = [];
  for (const raw of params.getAll("type")) {
    const type = raw.trim();
    if (type.length > 0 && !types.includes(type)) {
      types.push(type);
    }
  }
  return types;
}

/**
 * The feed view's parameters from a query string alone (node-views).
 * `view` is the only one; missing, empty, or whitespace-only degrades to
 * `null` the way `q`/`node` do above, and anything else is ignored — a
 * graph parameter on a feed address is not carried anywhere, since the
 * feed has no search to apply it to.
 */
function feedRouteFromSearch(search: string): FeedRoute {
  const params = new URLSearchParams(search);
  return { view: "feed", viewId: nonEmpty(params.get("view")) };
}

/**
 * The code view's parameters from a query string alone (code-view). `view`
 * and `node`, each degraded to `null` through the same trim the feed's
 * `view` and the graph's `node` get; anything else is ignored — the code
 * view has no search to carry `q` or `type` to.
 */
function codeRouteFromSearch(search: string): CodeRoute {
  const params = new URLSearchParams(search);
  return { view: "code", viewId: nonEmpty(params.get("view")), node: nonEmpty(params.get("node")) };
}

/**
 * The timeline view's parameters from a query string alone (timeline-view).
 * `view` and `node` through the same trim as the code view's; `type`
 * collected as the graph's is (`typesFrom`); anything else is ignored —
 * the timeline has no search to carry `q` to.
 */
function timelineRouteFromSearch(search: string): TimelineRoute {
  const params = new URLSearchParams(search);
  return { view: "timeline", viewId: nonEmpty(params.get("view")), node: nonEmpty(params.get("node")), types: typesFrom(params) };
}

/**
 * The board view's parameters from a query string alone (live-beads-board).
 * `view` and `item` through the same trim as the others'; every `project`
 * trimmed, empties dropped, duplicates collapsed to their first occurrence;
 * anything else is ignored.
 */
function boardRouteFromSearch(search: string): BoardRoute {
  const params = new URLSearchParams(search);
  const projects: string[] = [];
  for (const raw of params.getAll("project")) {
    const project = raw.trim();
    if (project.length > 0 && !projects.includes(project)) {
      projects.push(project);
    }
  }
  return { view: "board", viewId: nonEmpty(params.get("view")), projects, item: nonEmpty(params.get("item")) };
}

/**
 * The route a `pathname` + `search` pair names, or `null` when the path is
 * not a view we have — the caller's cue to redirect to
 * `formatRoute(graphRouteFromSearch(search))`. Exactly `/graph`, `/feed`,
 * `/code`, `/timeline`, or `/board` (one trailing slash tolerated, no case folding)
 * is a view; `/`, `/list`, `/graph/x`, `/feed/x`, `/code/x`,
 * `/timeline/x`, `/board/x` are all unknown.
 */
export function parseRoute(pathname: string, search: string): Route | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === GRAPH_VIEW_PATH) {
    return graphRouteFromSearch(search);
  }
  if (path === FEED_VIEW_PATH) {
    return feedRouteFromSearch(search);
  }
  if (path === CODE_VIEW_PATH) {
    return codeRouteFromSearch(search);
  }
  if (path === TIMELINE_VIEW_PATH) {
    return timelineRouteFromSearch(search);
  }
  if (path === BOARD_VIEW_PATH) {
    return boardRouteFromSearch(search);
  }
  if (path === INBOX_VIEW_PATH) {
    const params = new URLSearchParams(search);
    const source = nonEmpty(params.get("source"));
    return source === null ? { view: "inbox", item: nonEmpty(params.get("item")) } : { view: "inbox", item: nonEmpty(params.get("item")), source };
  }
  return null;
}

/**
 * The URL (path + query string, no origin) for a route. Parameters are
 * emitted in a fixed order — for the graph `q`, each `type` in order,
 * `node`; for the feed just `view`; for the code view `view` then `node`;
 * for the timeline `view`, `node`, then each `type` in order; for the board
 * `view`, each `project` in order, then `item` — and
 * absent ones are omitted, so two structurally equal routes always
 * format to the same string: lib/navigate.ts relies on that to skip a
 * history write when nothing changed. Round-trips through `parseRoute`.
 */
export function formatRoute(route: Route): string {
  switch (route.view) {
    case "graph":
      return formatGraphRoute(route);
    case "feed":
      return formatFeedRoute(route);
    case "code":
      return formatCodeRoute(route);
    case "timeline":
      return formatTimelineRoute(route);
    case "board":
      return formatBoardRoute(route);
    case "inbox": {
      const params = new URLSearchParams();
      if (route.item !== null) params.set("item", route.item);
      if (route.source != null) params.set("source", route.source);
      const query = params.toString();
      return query === "" ? INBOX_VIEW_PATH : `${INBOX_VIEW_PATH}?${query}`;
    }
  }
}

function formatGraphRoute(route: GraphRoute): string {
  const params = new URLSearchParams();
  if (route.q !== null) {
    params.set("q", route.q);
  }
  for (const type of route.types) {
    params.append("type", type);
  }
  if (route.node !== null) {
    params.set("node", route.node);
  }
  const query = params.toString();
  return query.length > 0 ? `${GRAPH_VIEW_PATH}?${query}` : GRAPH_VIEW_PATH;
}

function formatFeedRoute(route: FeedRoute): string {
  if (route.viewId === null) {
    return FEED_VIEW_PATH;
  }
  const params = new URLSearchParams();
  params.set("view", route.viewId);
  return `${FEED_VIEW_PATH}?${params.toString()}`;
}

function formatCodeRoute(route: CodeRoute): string {
  const params = new URLSearchParams();
  if (route.viewId !== null) {
    params.set("view", route.viewId);
  }
  if (route.node !== null) {
    params.set("node", route.node);
  }
  const query = params.toString();
  return query.length > 0 ? `${CODE_VIEW_PATH}?${query}` : CODE_VIEW_PATH;
}

function formatTimelineRoute(route: TimelineRoute): string {
  const params = new URLSearchParams();
  if (route.viewId !== null) {
    params.set("view", route.viewId);
  }
  if (route.node !== null) {
    params.set("node", route.node);
  }
  for (const type of route.types) {
    params.append("type", type);
  }
  const query = params.toString();
  return query.length > 0 ? `${TIMELINE_VIEW_PATH}?${query}` : TIMELINE_VIEW_PATH;
}

function formatBoardRoute(route: BoardRoute): string {
  const params = new URLSearchParams();
  if (route.viewId !== null) {
    params.set("view", route.viewId);
  }
  for (const project of route.projects) {
    params.append("project", project);
  }
  if (route.item !== null) {
    params.set("item", route.item);
  }
  const query = params.toString();
  return query.length > 0 ? `${BOARD_VIEW_PATH}?${query}` : BOARD_VIEW_PATH;
}
