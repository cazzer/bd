// A `view` node's filter, as the views that draw one send it to `list`
// (node-views, design.md decisions 1 and 6; lifted out of FeedView.tsx by
// code-view, design.md decision 3, so the feed and the code view share
// one guard rather than two copies that could drift). Pure: the only
// import is the client's types, so a node-environment test can exercise
// it without a browser.

import type { trpc } from "../trpc.js";

type ListInput = Parameters<typeof trpc.list.query>[0];
/** A view's `filter` as the views send it: `list`'s input without the reader's own `limit`/`cursor`. */
export type ViewFilter = Omit<ListInput, "limit" | "cursor">;
/** One `getNodes` row — the shape a view node arrives in. */
export type ViewNode = Awaited<ReturnType<typeof trpc.getNodes.query>>["nodes"][number];

/**
 * The view's filter, or `null` when the node is not a view or its
 * `metadata.filter` is not an object. `limit`/`cursor` are dropped
 * rather than trusted: the contract refuses them at write time, so a
 * row carrying them was hand-edited, and each view's page size is its
 * own. The cast is the one place the client asserts the server's
 * contract; a hand-edited filter the schema rejects surfaces as `list`'s
 * BAD_REQUEST, shown as an error by the view.
 */
export function viewFilterOf(node: ViewNode): ViewFilter | null {
  if (node.nodeType !== "view") {
    return null;
  }
  const filter = (node.metadata as Record<string, unknown>)["filter"];
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return null;
  }
  const { limit: _limit, cursor: _cursor, ...rest } = filter as Record<string, unknown>;
  return rest as ViewFilter;
}
