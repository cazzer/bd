## Context

See proposal.md — Why. The explorer is one component, `apps/web/src/App.tsx`, holding every piece of state this change touches: `query` (the controlled search box text), `chips` (active node-type filters), `selectedNodeId`, and the write sites where those change — `runSearch` (a result lands), `handleNodeClick` (select + expand), `DetailPanel`'s `onClose`, `handleNoteCreated` / `handleShowUnlinkedNote` (select a node that was just drawn on its own), `handleChooseSuggestion` / `handleRemoveChip` / `handleToggleTypeFocus` (chip edits). There is no router; `main.tsx` renders `<App/>` under `StrictMode`. Vite's dev server serves `index.html` for every path (its default `appType: "spa"` history fallback), and the tRPC server only answers under `/trpc/`, so `/graph` reaches the app with no server work. Node ids are UUIDs. `trpc.getNodes({ ids })` already returns `nodes` and `notFoundIds`.

Constraints this design keeps: pure logic lives in `src/lib/*.ts` with a colocated vitest test in the node environment (there is no jsdom and no component test harness — `bd-7l2` is open for that and is not pulled in here); derived values are computed in render, not in effects; no new dependency.

## Goals / Non-Goals

**Goals:**

- One place that knows the URL's shape, pure and tested, with a `view` discriminant a second view can be added to without touching the first.
- History writes at exactly the state-change sites the spec names, each choosing push or replace deliberately.
- A deep link and a back/forward step go through the same "apply this route" path, so the two cannot drift.

**Non-Goals:**

- No router library, no nested routes, no route-level data loading (proposal.md — Impact names the rejected alternative).
- No `document.title` changes, no per-view `<title>` — cheap, but a separate decision.
- No attempt to make expansion reversible through history.

## Decisions

### 1. A discriminated route type in `src/lib/route.ts`, not a router

```ts
type GraphRoute = { view: "graph"; q: string | null; types: string[]; node: string | null };
type Route = GraphRoute; // a future view widens this union
parseRoute(pathname: string, search: string): Route | null  // null: unknown view
graphRouteFromSearch(search: string): GraphRoute            // the parameters alone, path ignored
formatRoute(route: Route): string                           // "/graph?q=…&type=…&type=…&node=…"
```

`parseRoute` accepts `/graph` and `/graph/`; anything else returns `null`, and the caller redirects to `formatRoute(graphRouteFromSearch(search))` — the parameters are parsed regardless of the path (that second export is what `parseRoute` itself uses internally), so `/?q=x` and `/list?q=x` both land on `/graph?q=x`, and App's lazy initial state (decision 3) can read them before the redirect happens. Parsing never throws: an empty `q` or `node` becomes `null`, empty `type` values are dropped, duplicates are collapsed preserving first occurrence. `formatRoute` emits parameters in a fixed order (`q`, each `type`, `node`) and omits absent ones, so equal routes format to equal strings — App relies on that to skip a history write when nothing changed. `node` is not validated as a UUID at parse time: the server already validates it, and `getNodes`'s `notFoundIds` is how a bad id is discovered (decision 4), so a format check here would be a second, weaker copy of the same rule.

*Rejected:* react-router (or wouter). One view with three parameters does not need matching, layouts, or loaders; the cost is a dependency, a `BrowserRouter` wrapper around the only component, and route logic that can only be tested in a DOM. A parse/format pair is a plain function with a plain test, which is the pattern every other `src/lib` module already follows.

### 2. App owns the URL through two explicit sites, not an effect that mirrors state

Two new pieces of state in `App`: `submittedSearch: { q: string; types: string[] } | null` — what the drawn graph is the result of — and nothing else; `selectedNodeId` and `chips` already exist. The URL is written at exactly two kinds of moment:

- **A result lands** (`runSearch`'s `result.mode !== "empty"` branch): set `submittedSearch`, then `history.pushState` with `formatRoute({ view: "graph", q, types, node: null })`. This is the one push. A query that matched nothing does not touch the URL (spec: the address names the search whose result is drawn).
- **The selection changes** (`handleNodeClick`, `DetailPanel`'s `onClose`, `handleNoteCreated`, `handleShowUnlinkedNote`): `history.replaceState` with the current `submittedSearch` plus the new `node`. Replace, never push — see proposal.md — What Changes for why per-click history stops are wrong here.

A small `navigate(route, "push" | "replace")` helper inside App does the `formatRoute`, the equal-string skip, and the `history.*State` call, so no site calls the History API directly. Nothing is stored in `history.state`: the URL is the only source of truth, which is what makes a popstate and a pasted URL the same input.

Today's `handleNodeClick` (select + expand) splits in two: `selectNode(node)` does exactly what it does now and never touches history, and `handleNodeClick(node)` is `selectNode` followed by the replace-write. `GraphCanvas`'s click/keyboard path keeps calling `handleNodeClick`; the route-applied selection in decisions 3–4 calls `selectNode`. The reason is a stale read: a selection applied right after `await runSearch(...)` runs before the new `submittedSearch` has committed, so a replace-write there would emit the *previous* query with the *new* node.

*Rejected:* a `useEffect` over `[submittedSearch, chips, selectedNodeId]` that syncs the URL. It looks tidier but cannot tell push from replace without a second "why did this change" flag, and it would fire on the popstate path too (state set from the URL → effect writes the URL back → a no-op only if the equal-string skip is perfect). Explicit sites are the same shape the codebase already uses for `setFitRequestId` — bumped at the one place a fit is wanted, never derived.

`chips` edits do not write the URL. They are pending until submitted (proposal.md — Non-Goals), which is also what makes `runSearch` the single push site. `runSearch` gains an explicit `types` argument rather than reading `chips` from its closure, so the deep-link and popstate paths (decision 3) can run a search whose chips have not yet been committed to state.

### 3. One `applyRoute` path serves both the initial load and `popstate`

Initial state comes from the URL through lazy `useState` initializers (`query` ← `route.q ?? ""`, `chips` ← `route.types`), not from an effect — the first render is already correct. The one thing that needs an effect is the fetch: a mount effect parses `location`, redirects if `parseRoute` returned `null` (replace, then re-parse), and calls `applyRoute(route)`. Under `StrictMode` that effect runs twice in dev; a `useRef` guard (the same shape as `inFlightExpansions`) makes the second run a no-op rather than a second search.

`applyRoute(route)` is also what the `popstate` listener calls. Its logic:

1. Set `query` and `chips` from the route (so the box and chips always show what the URL says).
2. If `route.q` is null: clear `submittedSearch`; nothing to search; if `route.node` is set, fall through to step 4 with the current graph.
3. If `route.q`/`route.types` differ from `submittedSearch`: run the search (`runSearch(route.q, route.types, { history: "none" })` — the search was *navigated to*, so it must not push again). If the result is empty, stop: the spec's "nothing matched" behaviour is unchanged, and the URL already is what it is.
4. Apply `route.node` (decision 4). If `route.q`/`route.types` match `submittedSearch`, this is the only step that does anything — the "only the selection changed" scenario, and the reason back/forward between selections is cheap.

`runSearch` takes a `history` option (`"push"` for a submit, `"none"` when applying a route) rather than a boolean, so the call sites read as what they mean, and it *returns* the landed result (or `null` for empty/failed) so `applyRoute` can tell "graph replaced" from "nothing changed" without waiting for state to commit.

The `popstate` listener is registered once in a mount effect and removed on unmount, but it must not call the `applyRoute` from that first render — that closure holds `submittedSearch` as `null` and `graph` as empty forever, which would silently turn every back/forward into a full re-search and make the "only the selection changed" scenario impossible. So the listener calls through a ref (`applyRouteRef.current`) that a no-dependency-array effect refreshes with the current render's `applyRoute` — the listener body reads no state of its own.

One more guard in step 4: when the search was not re-run and `route.node` is already the selected node, do nothing. `expandNode` with an existing cursor fetches the *next* page, so re-selecting would silently pull extra neighbours on a back/forward step that changed nothing.

### 4. Selecting a deep-linked node reuses the click path and the standalone-draw path

Given the landed result (or the current graph when no search ran): find the node by id. If found, call `selectNode(node)` — select, summary panel, expand — so a deep link to a node looks exactly like having clicked it (minus the URL write, which the URL already is). If not found, `trpc.getNodes({ ids: [id] })`; a returned node goes through `graphNodeFromUnlinkedNote` + `mergeStandaloneNode` (the `handleShowUnlinkedNote` path — the lookup DTO carries id/title/type/source and is accepted structurally, no adapter) and then `selectNode`. The lookup DTO has no `degree`, so such a node draws at the minimum radius and its panel reads degree 0 until a search returns it; adding `degree` to the lookup is a server change the proposal excludes, and the trade is accepted here. If the returned node's id differs from the requested one (a merged-away id resolved to its survivor), replace the URL's `node` with the survivor's id. If `notFoundIds` names it, select nothing and `navigate(replace)` without `node`, so the bad id does not survive a reload. A failed `getNodes` call is reported through the existing expansion-error toast text path ("Couldn't open …") and otherwise treated as not found.

The node lookup after a search reads the *result* (`searchResultToGraphData(result).nodes`) rather than `graph` state, because `setGraph` has not committed yet when `runSearch` returns — the same reason `handleAnnotated` captures `target.degree` before its updater runs.

### 5. Unknown paths redirect, carrying parameters

`parseRoute` returning `null` means "not a view we have," and the answer is `history.replaceState` to `/graph` with the same query string, then continue as if that had been the URL. Replace, so the redirect is never a back stop. No 404 page: this is a single-user local tool with one view; a wrong path is far more likely a stale bookmark than a real request for something missing. When a second view exists, `parseRoute` learns its name and this branch stops firing for it — nothing else changes.

## Risks / Trade-offs

- [Back after exploring re-runs the search and drops expansions] → Inherent to "the address is a search, not a session" (proposal.md — Non-Goals). The re-fit on a landed result (`fitRequestId`) makes the reset legible rather than a silent jump. Only a *different* search re-runs; a selection-only step keeps the graph (decision 3, step 4).
- [Two searches on dev mount under StrictMode] → `useRef` guard in the mount effect (decision 3).
- [`runSearch` currently reads `chips` from its closure] → Explicit `types` argument; the submit path passes `chips`, the route paths pass the route's types. Every existing caller is updated in the same change.
- [The URL says `node=X` but the panel shows nothing because the fetch failed] → Failure surfaces in the toast and the URL is replaced without `node` (decision 4), so URL and screen agree again.
- [A future view wants parameters `graph` does not] → The union in decision 1 is per-view; `formatRoute` switches on `view`. Nothing in App assumes `Route` is `GraphRoute` beyond the one place it constructs it.
- [Vite production serving] → There is no production static server today (only `vite build`); if one is added it needs history fallback to `index.html`, the same requirement any SPA has. Noted, not solved here.
