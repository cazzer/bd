// The search results view's pure half (search-results-view, design.md
// decision 6): which route a submitted text names, what `find` is asked
// for a route, where a result opens, where "Open in graph" goes, and the
// next route a filter toggle gives. SearchView.tsx owns when each runs;
// this module owns what each one means, so a node-environment test can
// pin it without a browser. The only import from the client is its types.
//
// A result opens where it is best read (search-results/spec.md): a review
// with a project opens its board drawer in that project, which loads the
// item through `boardItem` whether or not its card made the closed
// column; anything else opens the graph with the node selected.

import type { trpc } from "../trpc.js";
import type { GraphRoute, Route, SearchRoute } from "./route.js";

/** `find`'s input as the client sends it. */
export type FindInput = NonNullable<Parameters<typeof trpc.find.query>[0]>;
/** One `find` answer. */
export type FindResult = Awaited<ReturnType<typeof trpc.find.query>>;
/** One result row, a summary only (no content, no metadata). */
export type FoundRow = FindResult["nodes"][number];
/** One facet option as the server counts it. */
export type FacetCount = FindResult["facets"]["nodeTypes"][number];

/** A facet option as the view renders it: the server's count, and whether the route has it chosen. */
export interface FacetOption {
  value: string;
  count: number;
  chosen: boolean;
}

/** The results route for submitted `text` (trimmed; whitespace-only is no text, never "do nothing"), with the given filters or none. */
export function searchRouteFor(text: string, filters: Partial<Pick<SearchRoute, "types" | "projects" | "reviewsOnly">> = {}): SearchRoute {
  const trimmed = text.trim();
  return {
    view: "search",
    q: trimmed.length === 0 ? null : trimmed,
    types: filters.types ?? [],
    projects: filters.projects ?? [],
    reviewsOnly: filters.reviewsOnly ?? false,
  };
}

/**
 * `find`'s input for one page of `route`. Empty filter lists are sent as
 * absent, never `[]` — the server's schema requires each list to be absent
 * or non-empty — and `text`/`reviewsOnly` only when set.
 */
export function findInputFor(route: SearchRoute, offset: number, limit: number): FindInput {
  return {
    ...(route.q !== null ? { text: route.q } : {}),
    nodeTypes: route.types.length > 0 ? route.types : undefined,
    projects: route.projects.length > 0 ? route.projects : undefined,
    ...(route.reviewsOnly ? { reviewsOnly: true } : {}),
    limit,
    offset,
  };
}

/** Where activating a result goes: a review with a project to its board drawer (keyed by its external id, the bead id), anything else to the graph with it selected. */
export function resultRoute(row: Pick<FoundRow, "id" | "externalId" | "project" | "isReview">): Route {
  if (row.isReview && row.project !== null) {
    return { view: "board", viewId: null, projects: [row.project], item: row.externalId };
  }
  return { view: "graph", q: null, types: [], node: row.id };
}

/** The graph drawing the current text's matches with the chosen types, or `null` when there is no text — the graph draws only from a query, so the link is hidden. */
export function openInGraphRoute(route: SearchRoute): GraphRoute | null {
  if (route.q === null) {
    return null;
  }
  return { view: "graph", q: route.q, types: route.types, node: null };
}

function toggled(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** `route` with node type `type` chosen if it was not, unchosen if it was; order kept, a new value appended. */
export function toggleType(route: SearchRoute, type: string): SearchRoute {
  return { ...route, types: toggled(route.types, type) };
}

/** `route` with `project` chosen if it was not, unchosen if it was; order kept, a new value appended. */
export function toggleProject(route: SearchRoute, project: string): SearchRoute {
  return { ...route, projects: toggled(route.projects, project) };
}

/** `route` with reviews only set to `on`. */
export function withReviewsOnly(route: SearchRoute, on: boolean): SearchRoute {
  return { ...route, reviewsOnly: on };
}

/**
 * The options to render for one facet: the server's, in the server's
 * order (chosen first, then count), each marked chosen or not, then every
 * chosen value the server left out — it matched nothing — at 0, so it can
 * still be unchosen.
 */
export function facetOptions(counts: readonly FacetCount[], chosen: readonly string[]): FacetOption[] {
  const options = counts.map((c) => ({ value: c.value, count: c.count, chosen: chosen.includes(c.value) }));
  for (const value of chosen) {
    if (!counts.some((c) => c.value === value)) {
      options.push({ value, count: 0, chosen: true });
    }
  }
  return options;
}

/** The status line for a row: `closed YYYY-MM-DD` when `closedAt` is a readable time, else its status, else `null`. */
export function rowStatus(row: Pick<FoundRow, "status" | "closedAt">): string | null {
  if (row.closedAt !== null) {
    const closed = new Date(row.closedAt);
    if (!Number.isNaN(closed.getTime())) {
      return `closed ${closed.toISOString().slice(0, 10)}`;
    }
  }
  return row.status;
}
