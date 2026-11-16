// The Views menu's rows (shared-nav-header, design.md decision 5): the
// store's saved `view` nodes, as `list` answers them, grouped by renderer
// and each turned into the address that opens it. Pure, so a node test
// covers it; components/ViewsMenu.tsx reads and draws.
//
// The graph renderer is left out: no address opens a saved graph view (the
// graph route has no `view` parameter), the same reason DetailPanel's
// "Open as" offers only these four (`OfferedRenderer`).

import type { Route } from "./route.js";

export type SavedViewRenderer = "feed" | "code" | "timeline" | "board";

/** The menu's group order, and each group's heading. */
export const SAVED_VIEW_GROUPS: ReadonlyArray<{ renderer: SavedViewRenderer; label: string }> = [
  { renderer: "feed", label: "Feeds" },
  { renderer: "code", label: "Code views" },
  { renderer: "timeline", label: "Timelines" },
  { renderer: "board", label: "Boards" },
];

export interface SavedView {
  id: string;
  title: string;
}

export interface SavedViewGroup {
  renderer: SavedViewRenderer;
  label: string;
  views: SavedView[];
}

/** The fields of a `list` row this reads. */
export interface ViewRow {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
}

export const UNTITLED_VIEW = "(untitled view)";

/**
 * The rows grouped by `metadata.renderer` in `SAVED_VIEW_GROUPS` order, each
 * group sorted by title (then id, so equal titles keep a stable order). A
 * renderer with no rows has no group; a row naming another renderer (graph,
 * or one written outside the contract) is left out.
 */
export function groupSavedViews(rows: readonly ViewRow[]): SavedViewGroup[] {
  const groups: SavedViewGroup[] = [];
  for (const { renderer, label } of SAVED_VIEW_GROUPS) {
    const views = rows
      .filter((row) => row.metadata["renderer"] === renderer)
      .map((row) => ({ id: row.id, title: row.title.trim() === "" ? UNTITLED_VIEW : row.title }))
      .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (views.length > 0) groups.push({ renderer, label, views });
  }
  return groups;
}

/** The address that opens saved view `id` in its renderer, carrying `projects`; nothing else chosen. */
export function savedViewRoute(renderer: SavedViewRenderer, id: string, projects: readonly string[]): Route {
  const carried = [...projects];
  switch (renderer) {
    case "feed":
      return { view: "feed", viewId: id, projects: carried };
    case "code":
      return { view: "code", viewId: id, node: null, projects: carried };
    case "timeline":
      return { view: "timeline", viewId: id, node: null, types: [], projects: carried };
    case "board":
      return { view: "board", viewId: id, projects: carried, item: null };
  }
}
