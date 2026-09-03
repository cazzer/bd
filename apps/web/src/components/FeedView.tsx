// Placeholder for the feed view (node-views, task group 2). The shell
// mounts this under `/feed` so the route, the view switch, and the shared
// `navigate` are exercised before the real feed lands in group 3
// (design.md decision 6), which replaces this file's body. It shows what
// the address named and a way to the graph, and never redirects —
// node-views/spec.md, "The feed view is addressable": `/feed` with no
// view id "SHALL show an empty state ... and SHALL NOT redirect".

import type { MouseEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

export function FeedView({ viewId }: { viewId: string | null }) {
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

  return (
    <main className="flex h-dvh w-screen items-center justify-center overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="glass w-96 p-6">
        <h1 className="text-base font-semibold text-fg">Feed</h1>
        {/* User copy never repeats a raw id (url-addressable-views review): it is in the address bar. */}
        <p className="mt-2 text-sm text-fg-muted">{viewId === null ? "No view is named in the address." : "The feed for this view is not built yet."}</p>
        <a href={formatRoute(GRAPH_HOME)} onClick={handleOpenGraph} className="mt-4 inline-block rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
          Open the graph
        </a>
      </div>
    </main>
  );
}
