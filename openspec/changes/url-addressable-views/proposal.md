## Why

The explorer's state — what was searched, which types it was filtered to, which node is open — lives only in React state inside `App.tsx`. A reload drops it, the browser's back button leaves the page, and there is no way to hand someone (or a future self, or a Claude session) a link to "this node, in this search." The URL is always `/`.

That also means the current force-graph view has no name. Other ways to look at the same items are plausible later — a list, a table, a timeline — and adding a second view to an app whose only address is `/` means renaming the first one under people's bookmarks. Naming the view now, while it is the only one, is the cheap moment to do it.

## What Changes

- **The force-graph view is named `graph`, and its path is `/graph`.** `/`, and any path that is not a known view, redirects to `/graph` (replacing, not pushing, so the redirect never becomes a back-button stop). The query string is carried across the redirect, since it describes *which items*, not *how they are shown*.
- **The submitted search is in the URL.** `q` is the query as last submitted (not keystrokes), and `type` (repeatable) is the set of node-type chips it was submitted with. Landing a search result pushes a history entry.
- **The selected node is in the URL.** `node` is the selected node's id. Selecting or closing a node replaces the current entry rather than pushing one — a click is the explorer's most frequent gesture and also expands, which back cannot undo, so per-click history stops would be half-reversible.
- **Loading a URL reproduces it.** Opening `/graph?q=…&type=…&node=…` runs that search with those chips, then selects and expands that node exactly as a click would. A `node` that the search did not return is fetched and drawn on its own, the same way an unlinked note is shown today. A `node` that does not exist is dropped from the URL, and the search result is still shown.
- **Back and forward work.** A history change re-applies the URL's state: a different search re-runs it; a different selection alone just re-selects.

## Non-Goals

- **Exploration is not addressable.** Expansions, pan, and zoom stay out of the URL — the address reproduces a search and a selection, not a session. So do `focusedType` and the detail panel's expanded/summary state, both transient reading aids.
- **Pending edits are not in the URL.** Typed-but-unsubmitted text and chips added or removed since the last submit are pending, like a form; the URL is the last search that was actually asked for. Reloading loses pending edits the same way it loses typed text today.
- **No second view is built.** This change names the first view and makes the route type ready for another; it does not add one.
- **No server change, no new dependency.** Vite's dev server already serves `index.html` for any path, the API is tRPC-only under `/trpc/`, and `getNodes` already exists for the "node not in result" case.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `graph-explorer`: the view is addressable — a new requirement that the explorer's submitted search and selection are reflected in, and reproducible from, the page URL, under a named view path; plus back/forward and unknown-path behaviour.

## Impact

- Changed, `apps/web` only: `src/App.tsx` (owns the route: initial state from the URL, history writes at the search-landed and selection-changed sites, a `popstate` listener, deep-link node fetch via the existing `getNodes` procedure).
- New: `src/lib/route.ts` (+ test) — a pure parse/format pair over a discriminated route type whose `view` field is where a future view is added.
- Unchanged: every tRPC procedure, `packages/core`, `packages/db`, `apps/mcp`, the CSP in `index.html`, `vite.config.ts`. No new dependencies; no schema migration.
- The alternative of adding a router library (react-router or similar) was rejected: one view with three query parameters does not need route matching, nested layouts, or data loaders, and the project already keeps pure logic in `src/lib` with node-environment tests — a parser is testable, a router is not.
