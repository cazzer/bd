// Placeholder for the code view (code-view, task group 1). The shell
// mounts this under `/code` so the route, the view switch, the shared
// `navigate`, and the detail panel's "Open as code" push are exercised
// before the real view lands in group 2 (design.md decisions 3, 4, and 6),
// which replaces this file's body. It shows what the address named and a
// way to the graph, and never redirects — code-view/spec.md, "The code
// view is addressable": `/code` with no view "SHALL be shown as a distinct
// empty state that keeps the address ... the view SHALL NOT redirect".
// The same shape the feed's placeholder had (node-views, task 2.4).

import type { MouseEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

export function CodeView({ viewId, node }: { viewId: string | null; node: string | null }) {
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
  // in the address bar. Group 2 turns `node` into the shown file; here it
  // only shapes the sentence.
  const copy =
    viewId === null
      ? "No view is named in the address."
      : node === null
        ? "The code view for this view is not built yet."
        : "The code view for this view and node is not built yet.";

  return (
    <main className="flex h-dvh w-screen items-center justify-center overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="glass w-96 p-6">
        <h1 className="text-base font-semibold text-fg">Code</h1>
        <p className="mt-2 text-sm text-fg-muted">{copy}</p>
        <a href={formatRoute(GRAPH_HOME)} onClick={handleOpenGraph} className="mt-4 inline-block rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
          Open the graph
        </a>
      </div>
    </main>
  );
}
