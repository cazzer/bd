// Placeholder for the timeline view (timeline-view, task group 2). The
// shell mounts this under `/timeline` so the route, the view switch, the
// shared `navigate`, and the detail panel's "Open as timeline" push are
// exercised before the real view lands in group 3 (design.md decision 5),
// which replaces this file's body. It shows what the address named and a
// way to the graph, and never redirects — timeline-view/spec.md, "The
// timeline view is addressable": each empty state "SHALL NOT redirect or
// change the address". The same shape the code view's placeholder had
// (code-view, task 1.5).

import type { MouseEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

export function TimelineView({ viewId, node, types }: { viewId: string | null; node: string | null; types: string[] }) {
  // A real `href` so the link is a link (middle-click, copy address); a
  // plain left click goes through `navigate` so the shell swaps views
  // without a page load, the way every in-app move does.
  function handleOpenGraph(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(GRAPH_HOME, "push");
  }

  // User copy never repeats a raw id (url-addressable-views review): it is
  // in the address bar. Group 3 turns `node` into the anchor and `types`
  // into the chips; here they only shape the sentence.
  const copy =
    viewId === null
      ? "No view is named in the address."
      : node === null
        ? "The timeline for this view is not built yet."
        : types.length === 0
          ? "The timeline for this view and anchor is not built yet."
          : `The timeline for this view and anchor, narrowed to ${types.length} ${types.length === 1 ? "type" : "types"}, is not built yet.`;

  return (
    <main className="flex h-dvh w-screen items-center justify-center overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="glass w-96 p-6">
        <h1 className="text-base font-semibold text-fg">Timeline</h1>
        <p className="mt-2 text-sm text-fg-muted">{copy}</p>
        <a href={formatRoute(GRAPH_HOME)} onClick={handleOpenGraph} className="mt-4 inline-block rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
          Open the graph
        </a>
      </div>
    </main>
  );
}
