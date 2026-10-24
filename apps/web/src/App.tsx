// The app shell (node-views, design.md decision 4): parses `location`
// into a `Route` and mounts the view it names — GraphView under `/graph`
// (src/components/GraphView.tsx, where everything this file used to be
// now lives, verbatim), FeedView under `/feed`, CodeView under `/code`,
// or TimelineView under `/timeline` (the last two lazy — see their
// imports below). It re-reads `location`
// on `popstate` and whenever a view calls the shared `navigate`
// (lib/navigate.ts), which notifies the subscriber registered below
// after it has written history. Nothing else: each view keeps its own
// URL handling (GraphView's `applyRoute`, its generation guards and its
// own `popstate` listener stayed with it — design.md decision 4 on why
// hoisting them here would re-open the races url-addressable-views'
// review closed). Crossing views unmounts one and mounts the other, so
// the graph starts empty and applies its route on mount, as a fresh page
// load does; exploration state was never addressable.
//
// The unknown-path redirect (url-addressable-views, design.md decision 5)
// lives here too: `/`, `/list?q=x`, a stale bookmark — anything
// `parseRoute` does not know — is replaced (never pushed, so it is never
// a back stop) with `/graph` carrying the same query string. `route`
// below already reads such an address as the graph's, so the first
// render is right before the address is; the effect only makes the
// address agree. StrictMode runs mount effects twice in dev; a ref guard
// (the same shape as GraphView's `didApplyInitialRoute`) keeps the second
// run from repeating the check. GraphView's own mount effect still
// performs the same replace (its body is verbatim), and child effects run
// before parent effects, so by the time this one runs the address is
// normally already `/graph` and `navigate`'s equal-URL skip makes it a
// no-op — harmless in either order, and each component's mount is
// complete on its own.
//
// Rendering switches on `route.view` and nothing narrower: a change of
// graph parameters re-renders the shell (a fresh `Route` object) but
// GraphView takes no props and keeps its key, so it is never remounted by
// a search or a selection — only by a change of view.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FeedView } from "./components/FeedView.js";
import { GraphView } from "./components/GraphView.js";
import { navigate, subscribeToNavigation } from "./lib/navigate.js";
import { graphRouteFromSearch, parseRoute, type Route } from "./lib/route.js";

// Lazy: CodeView carries CodeMirror's core, Lezer, and One Dark (its
// grammars are dynamic imports of their own already), none of which the
// graph or the feed needs, so its chunk is fetched on the first `/code`
// rather than with every page. Until it lands the shell shows a bare
// "Loading…"; the address is untouched either way.
const CodeView = lazy(async () => ({ default: (await import("./components/CodeView.js")).CodeView }));

// Lazy too, not for its size (the timeline has no heavy dependency) but so
// the pattern for a fourth view is the pattern for the third (timeline-
// view, design.md decision 6); it shares CodeView's fallback.
const TimelineView = lazy(async () => ({ default: (await import("./components/TimelineView.js")).TimelineView }));

// The board (live-beads-board): lazy like the timeline; a placeholder until
// the board component lands (task group 4).
const BoardView = lazy(async () => ({ default: (await import("./components/BoardView.js")).BoardView }));

const LOADING_VIEW = (
  <main className="flex h-dvh w-screen items-center justify-center">
    <p className="text-sm text-fg-muted">Loading…</p>
  </main>
);

/** The view `location` names right now; an unknown path counts as the graph's, its parameters carried (url-addressable-views, design.md decision 5). */
function routeFromLocation(): Route {
  return parseRoute(location.pathname, location.search) ?? graphRouteFromSearch(location.search);
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromLocation);
  const didCheckInitialPath = useRef(false);

  useEffect(() => {
    if (didCheckInitialPath.current) {
      return;
    }
    didCheckInitialPath.current = true;
    if (parseRoute(location.pathname, location.search) === null) {
      navigate(graphRouteFromSearch(location.search), "replace");
    }
  }, []);

  // Registered once; the handler reads nothing from this render, so it
  // never goes stale. `popstate` for the browser's own back/forward,
  // the subscription for every history write a view makes.
  useEffect(() => {
    function rereadLocation() {
      setRoute(routeFromLocation());
    }
    window.addEventListener("popstate", rereadLocation);
    const unsubscribe = subscribeToNavigation(rereadLocation);
    return () => {
      window.removeEventListener("popstate", rereadLocation);
      unsubscribe();
    };
  }, []);

  switch (route.view) {
    case "graph":
      return <GraphView key="graph" />;
    case "feed":
      return <FeedView key="feed" viewId={route.viewId} />;
    case "code":
      return (
        <Suspense fallback={LOADING_VIEW}>
          <CodeView key="code" viewId={route.viewId} node={route.node} />
        </Suspense>
      );
    case "timeline":
      return (
        <Suspense fallback={LOADING_VIEW}>
          <TimelineView key="timeline" viewId={route.viewId} node={route.node} types={route.types} />
        </Suspense>
      );
    case "board":
      return (
        <Suspense fallback={LOADING_VIEW}>
          <BoardView key="board" viewId={route.viewId} projects={route.projects} />
        </Suspense>
      );
  }
}
