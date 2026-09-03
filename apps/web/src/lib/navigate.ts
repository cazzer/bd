// The only caller of the History API (url-addressable-views, design.md
// decision 2 — moved out of App.tsx by node-views, design.md decision 4,
// so the shell and every view share one). `navigate` formats the route,
// skips the write when the address would not change, writes history, and
// then tells the subscriber the shell registered: App.tsx re-reads
// `location` in response and swaps views if the path changed. Views call
// this; nothing else touches `history`.
//
// The equal-URL skip: the string comparison is encoding-sensitive (`+`
// vs `%20`), so at worst it lets through a harmless extra
// `replaceState`; "did the search change" is never decided here but by
// GraphView's `isSameSearch` value comparison in `applyRoute`. Nothing
// goes into `history.state`: the URL is the sole source of truth, which
// is what makes a pasted link and a popstate the same input to a view.
//
// The subscriber runs AFTER the write, so its re-read of `location` sees
// the new address, and only when something was written — a skipped write
// is not a change the shell needs to hear about. A module-level set
// rather than a React context: the shell is the one subscriber in
// practice (StrictMode's double mount subscribes twice for a moment,
// hence a set and an unsubscribe), and a context would make a plain
// function's every caller need a hook. Like route.ts, nothing here is
// React; unlike route.ts, this module does touch `location` and
// `history`, which is why it is the one that does.

import { formatRoute, type Route } from "./route.js";

type NavigationListener = () => void;

const listeners = new Set<NavigationListener>();

/** Write `route` to the address — a new history entry for `"push"`, the current one rewritten for `"replace"` — then notify the shell. A no-op when the address already is `formatRoute(route)`. */
export function navigate(route: Route, mode: "push" | "replace"): void {
  const url = formatRoute(route);
  if (url === location.pathname + location.search) {
    return;
  }
  if (mode === "push") {
    history.pushState(null, "", url);
  } else {
    history.replaceState(null, "", url);
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Run `listener` after every history write `navigate` makes; returns the unsubscribe. App.tsx is the intended (and only) subscriber. */
export function subscribeToNavigation(listener: NavigationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
