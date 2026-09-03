// The explorer's URL, as a pure parse/format pair (url-addressable-views,
// design.md decision 1). One place knows the URL's shape; App.tsx owns
// WHEN it is read and written (design.md decisions 2-5), never how it is
// spelled.
//
// `Route` is a discriminated union on `view` so a second way of looking
// at the same items (a list, a table) can be added by widening the union
// and teaching `parseRoute`/`formatRoute` its name — nothing about the
// graph view has to move. Today the union has one member, which is
// exactly why the view gets named now, while the rename is free
// (proposal.md — Why).
//
// Not a router: one view with three query parameters needs no matching,
// layouts, or loaders, and a parse/format pair is a plain function with a
// plain test in the node environment, the same pattern every other
// `src/lib` module follows. Accordingly, this module never touches
// `window`, `location`, or `history` — callers hand it the strings.
//
// Parsing never throws and validates nothing beyond shape: a `node` that
// is not a UUID (or names no node) is the server's to reject —
// `getNodes`'s `notFoundIds` is how App.tsx discovers a bad id, and a
// format check here would be a second, weaker copy of that rule.

/** The graph view's path. `parseRoute` also accepts it with one trailing slash. */
export const GRAPH_VIEW_PATH = "/graph";

/** The force-graph view: the submitted query, the node-type filters it was submitted with, and the selected node. `null`/`[]` mean absent. */
export interface GraphRoute {
  view: "graph";
  q: string | null;
  types: string[];
  node: string | null;
}

/** Every addressable view. A future view widens this union. */
export type Route = GraphRoute;

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
  const types: string[] = [];
  for (const raw of params.getAll("type")) {
    const type = raw.trim();
    if (type.length > 0 && !types.includes(type)) {
      types.push(type);
    }
  }
  return { view: "graph", q: nonEmpty(params.get("q")), types, node: nonEmpty(params.get("node")) };
}

/**
 * The route a `pathname` + `search` pair names, or `null` when the path is
 * not a view we have — the caller's cue to redirect to
 * `formatRoute(graphRouteFromSearch(search))`. Exactly `/graph` (one
 * trailing slash tolerated, no case folding) is the graph view; `/`,
 * `/list`, `/graph/x` are all unknown.
 */
export function parseRoute(pathname: string, search: string): Route | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === GRAPH_VIEW_PATH) {
    return graphRouteFromSearch(search);
  }
  return null;
}

/**
 * The URL (path + query string, no origin) for a route. Parameters are
 * emitted in a fixed order — `q`, each `type` in order, `node` — and
 * absent ones are omitted, so two structurally equal routes always
 * format to the same string: App.tsx relies on that to skip a history
 * write when nothing changed. Round-trips through `parseRoute`.
 */
export function formatRoute(route: Route): string {
  switch (route.view) {
    case "graph":
      return formatGraphRoute(route);
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
