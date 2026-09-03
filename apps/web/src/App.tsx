// Search box, submitted query, results as a force-directed graph canvas
// (bd-hmd.4, see graph/encoding.ts for the merge/pin/pagination logic
// this component only orchestrates), click-to-expand (bd-hmd.5), node
// detail/editing/annotation/hand edges (bd-hmd.6), and — bd-8ub — the
// immersive shell those all now float inside of.
//
// --- The gesture conflict (bd-hmd.6's own decision, not up for
// redesign here) --------------------------------------------------------
//
// bd-hmd.5 made a single click expand a node's neighbours — the
// cheapest, most frequent gesture, and it stays exactly as built.
// Detail/editing needs a way in, and a click can't mean two things, so:
// "a click both expands and selects." `handleNodeClick` below does both
// in the same handler — no new gesture, no conflict — and `DetailPanel`
// simply reflects whichever node `selectedNodeId` last named, updating
// as the person keeps exploring. The keyboard path (GraphCanvas's
// sr-only node list, now real `<button>`s — see that file's header)
// calls this exact same handler, so "reachable by keyboard" is the same
// gesture too, not a second one.
//
// --- The shell (bd-8ub, openspec/changes/immersive-explorer-shell) -----
//
// "The map is the page" (design.md): GraphCanvas is the layout root,
// sized to the viewport by its own `fixed inset-0` wrapper below, never
// by flex space shared with a sibling. Every other control — search bar,
// type control (TypePanel), detail panel, note popover, unlinked-notes
// disclosure — is a separate `fixed`-positioned overlay layer with
// `pointer-events-none` on the layer itself and `pointer-events-auto`
// restored only on the actual panel inside it, so empty chrome passes
// clicks/drags straight through to the canvas. Because every layer is
// `fixed` (not `absolute` inside a positioned ancestor), none of this
// depends on an ancestor's height chain — each positions directly
// against the viewport regardless of nesting.
//
// --- Type control + search chips (bd-14q/bd-73t) ------------------------
//
// `nodeTypeCounts` (getStoreSummary().nodeTypes) is the one piece of
// this feature that's an actual fetch — see `refreshStoreSummary` below.
// Everything else is derived or plain UI state:
//   - `focusedType`: which type TypePanel's row click last focused on
//     the canvas (GraphCanvas's `focusedNodeType` prop) — cleared when a
//     fresh search result replaces the graph (design.md's Open Question,
//     resolved: "clearing with a new search", matching how
//     `selectedNodeId` already resets in that same branch of
//     `runSearch`).
//   - `chips`: active node_type filters, sent as `search`'s `nodeTypes`
//     input. TypePanel's focus-click and SearchBar's suggestion-choose
//     are two entry points into this ONE list (design.md: "one mechanism
//     for 'filter by this type'").
//   - the selected node's neighbour-type ranking and the search bar's
//     type suggestions are both derived plain values computed in the
//     render body below, never a `useEffect` — see graph/typePrevalence.ts
//     and lib/typeMatch.ts, both pure functions over state already held.
//
// --- The URL (url-addressable-views) -------------------------------------
//
// The explorer lives at the named view path `/graph`, and the URL carries
// the search as last SUBMITTED (`q`, repeatable `type`) plus the selected
// node (`node`) — never exploration (expansions, pan, zoom), never a
// reading aid (`focusedType`, the panel's summary/expanded state), never
// pending edits (typed text, chips changed since the last submit). The
// shape lives in lib/route.ts, pure and tested; this component owns
// when it is read and written, through exactly two kinds of site rather
// than an effect that mirrors state (design.md decision 2):
//   - `runSearch`'s landed-result branch is the ONE `pushState` — a
//     query that matched nothing leaves the URL naming the search whose
//     result is actually drawn.
//   - every site that changes the selection (`handleNodeClick`, the
//     panel's close, `handleNoteCreated`, `handleShowUnlinkedNote`)
//     does a `replaceState` — a click is the most frequent gesture here
//     and also expands, which back cannot undo, so a history stop per
//     click would be half-reversible.
// `submittedSearch` is what the drawn graph is the result of; `navigate`
// below is the only caller of the History API. Nothing is put in
// `history.state`: the URL is the sole source of truth, which is what
// makes a pasted link and a popstate the same input to `applyRoute`.

import { useEffect, useMemo, useRef, useState } from "react";
import { CreateNoteForm } from "./components/CreateNoteForm.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { SearchBar, type SearchBarStatus } from "./components/SearchBar.js";
import { TypePanel } from "./components/TypePanel.js";
import { UnlinkedNotes } from "./components/UnlinkedNotes.js";
import { EMPTY_GRAPH, mergeGraphData, searchResultToGraphData, setNodeDegree, type GraphCanvasData, type GraphNode, type SearchResult } from "./graph/encoding.js";
import {
  buildAnnotationNeighbor,
  buildAssertedLink,
  buildStandaloneNoteNode,
  cursorForExpansion,
  expandableNodeIds,
  graphNodeFromUnlinkedNote,
  mergeAssertedEdge,
  mergeExpansion,
  mergeNodePatch,
  mergeRetractedEdge,
  mergeReweightedEdge,
  mergeStandaloneNode,
  shouldFetchExpansion,
  withExpansionError,
  withExpansionLoading,
  withExpansionResult,
  type ExpansionEntries,
  type UnlinkedNote,
} from "./graph/expansion.js";
import { assignTypeColors } from "./graph/palette.js";
import { rankNeighborTypes, topStoreTypes, type TypeCount } from "./graph/typePrevalence.js";
import { formatRoute, graphRouteFromSearch, parseRoute, type GraphRoute } from "./lib/route.js";
import { matchNodeTypes } from "./lib/typeMatch.js";
import { trpc } from "./trpc.js";

/** Re-exported by SearchBar.tsx as `SearchBarStatus` — this file's own alias keeps the rest of the diff below readable. */
type Status = SearchBarStatus;

type AnnotateResult = Awaited<ReturnType<typeof trpc.annotateNode.mutate>>;
type AssertResult = Awaited<ReturnType<typeof trpc.assertEdge.mutate>>;
type CreateNoteResult = Awaited<ReturnType<typeof trpc.createNote.mutate>>;

/** bd-8ub review, should-fix 7: pairs the trigger's `aria-controls` with the popover's own `id` — an honest non-modal disclosure relationship, not `role="dialog"`/`aria-haspopup="dialog"` (there is no modal here: no focus trap, and outside-pointerdown closes it, wired below). */
const NOTE_POPOVER_ID = "new-note-popover";

// Right column sizing (bd-e9n, design.md decision 5) — pixel mirrors of
// the Tailwind classes the column and DetailPanel actually use (`right-4`,
// `w-80`, `w-96`), needed here only because GraphCanvas's `insetRight`
// prop is a plain number, not a CSS value. Keep in sync with those
// classes by hand — there is no single source of truth to derive them
// from, the same trade-off any Tailwind-to-JS pixel mirror makes.
const RIGHT_COLUMN_OFFSET_PX = 16; // right-4
const RIGHT_COLUMN_SUMMARY_WIDTH_PX = 320; // w-80
const RIGHT_COLUMN_EXPANDED_WIDTH_PX = 384; // w-96

/** What the drawn graph is the result of (url-addressable-views, design.md decision 2) — the search as submitted, not as typed. */
interface SubmittedSearch {
  q: string;
  types: string[];
}

/** Value comparison, never a URL-string one: whether `route` names the search `submitted` already drew (order-sensitive on types, matching the URL's own order). */
function isSameSearch(submitted: SubmittedSearch | null, route: GraphRoute): boolean {
  return submitted !== null && submitted.q === route.q && submitted.types.length === route.types.length && submitted.types.every((t, i) => t === route.types[i]);
}

export function App() {
  // The URL as it was when this component mounted (url-addressable-views,
  // design.md decision 3) — read once, lazily, so `query` and `chips`
  // below start out already correct on the first render instead of being
  // patched in by an effect. `graphRouteFromSearch` as the fallback is
  // what lets an unknown path's parameters (`/?q=x`) count before the
  // mount effect's redirect has had a chance to rewrite the address.
  const [initialRoute] = useState<GraphRoute>(() => parseRoute(location.pathname, location.search) ?? graphRouteFromSearch(location.search));
  const [query, setQuery] = useState(initialRoute.q ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [graph, setGraph] = useState<GraphCanvasData>(EMPTY_GRAPH);
  const [expansions, setExpansions] = useState<ExpansionEntries>(new Map());
  const [expansionError, setExpansionError] = useState<string | null>(null);
  // The node the detail panel reflects (bd-hmd.6) — null means closed.
  // Deliberately just an id, not a copy of the node: DetailPanel always
  // looks the current node up in `graph.nodes` itself, so it never goes
  // stale relative to a write that changed that node's own fields (e.g.
  // a saved title — see `mergeNodePatch`).
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Whether the currently-open detail panel is in its expanded state
  // (bd-e9n, design.md decision 6) — mirrors DetailPanel's own local
  // state (reported up via `onExpandedChange`, called only from its
  // "Show more"/"Show less" toggle, never on mount: DetailPanel remounts
  // with a fresh `key={selectedNodeId}` on every new selection, so its
  // own default `useState("summary")` already covers "a newly selected
  // node opens as a summary" without this needing to be reset from an
  // effect). Reset explicitly wherever `selectedNodeId` changes below,
  // the same way `setFocusedType(null)` already resets alongside a fresh
  // search's `setSelectedNodeId(null)` — kept in App rather than read
  // out of DetailPanel because insetRight (below) needs it to size the
  // shared right column, and DetailPanel has no reason to know about
  // insetRight at all.
  const [detailExpanded, setDetailExpanded] = useState(false);
  // Bumped only when a search result lands (design.md decision 5, review
  // follow-up: an earlier version also bumped this on every settled
  // expansion, but the settle path bumps regardless of whether the fetch
  // actually added anything, so the very first click on any node re-fit
  // the whole view — expansion never re-fits now; new nodes enter near
  // their parent per the existing "Expansion preserves the existing
  // layout" requirement, and the person can pan) — GraphCanvas compares
  // this against the id it last fit for, inside its own `onEngineStop`,
  // so a fit never fires for any other graph-mutating write (annotate,
  // connect, retract, reweight, a saved edit, an expansion) or for
  // opening/closing a panel alone. See GraphCanvas.tsx's `fitRequestId`
  // doc comment for the full reasoning.
  const [fitRequestId, setFitRequestId] = useState(0);
  // Concurrency guard for expandNode, deliberately NOT React state (bd-hmd.1's
  // review, reapplied to this UI — see the ticket report): two clicks on the
  // SAME node fired in the same tick would both read the same, not-yet-
  // re-rendered `expansions` snapshot and both pass `shouldFetchExpansion`,
  // since a `useState` update is only visible after the next render commits.
  // A ref is mutated (and checked) synchronously, so the second click sees
  // the first's "in flight" mark immediately — no re-render required.
  const inFlightExpansions = useRef<Set<string>>(new Set());

  // The search whose result is currently drawn (url-addressable-views) —
  // see this file's header. Set only where a result lands, in `runSearch`;
  // cleared by `applyRoute` when a navigated-to URL has no query.
  const [submittedSearch, setSubmittedSearch] = useState<SubmittedSearch | null>(null);
  // StrictMode guard for the initial-route mount effect below (design.md
  // decision 3): dev runs every mount effect twice, and the second run
  // must not be a second search. A ref, like `inFlightExpansions`, and
  // deliberately never reset in a cleanup — the simulated unmount is the
  // exact case this exists to ignore.
  const didApplyInitialRoute = useRef(false);
  // The current render's `applyRoute`, for the `popstate` listener — which
  // is registered once and would otherwise hold the FIRST render's closure
  // (`submittedSearch` null, `graph` empty) forever, turning every back/
  // forward step into a full re-search. Refreshed by a no-dependency
  // effect below, on purpose.
  const applyRouteRef = useRef<((route: GraphRoute) => Promise<void>) | null>(null);
  // Latest-wins guards (url-addressable-views review follow-up), both refs
  // like `inFlightExpansions` because each is read synchronously right
  // after an `await`, where a state value would be the snapshot from
  // before it. `searchGeneration` is bumped by every `runSearch` call; a
  // result whose call has since been superseded is dropped rather than
  // drawn, so two searches — two fast back/forward steps, or a submit
  // during a route-applied search — can never land out of order and leave
  // the canvas showing the earlier one under the later one's address.
  // `routeGeneration` does the same for `applyRoute`'s own steps after
  // each of its awaits (selecting, the out-of-result lookup, the URL
  // re-assert), which `runSearch` cannot know about.
  const searchGeneration = useRef(0);
  const routeGeneration = useRef(0);

  // The "New note" popover (bd-8ub, task 2.4) — CreateNoteForm itself is
  // unchanged (same onCreated contract); only its trigger and container
  // moved from an inline header row into this popover, opened from the
  // search bar's trailing slot.
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  const newNoteButtonRef = useRef<HTMLButtonElement | null>(null);
  const noteFormRef = useRef<HTMLDivElement | null>(null);

  function closeNoteForm() {
    setNoteFormOpen(false);
    newNoteButtonRef.current?.focus();
  }

  // bd-8ub review, should-fix 7: an honest non-modal popover closes when a
  // pointer lands outside both the popover and its own trigger — the
  // trigger is excluded so its own click (which already toggles
  // `noteFormOpen`) isn't immediately undone by this same listener.
  useEffect(() => {
    if (!noteFormOpen) return;
    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (noteFormRef.current?.contains(target)) return;
      if (newNoteButtonRef.current?.contains(target)) return;
      closeNoteForm();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [noteFormOpen]);

  // Type control + search chips (bd-14q/bd-73t) — see this file's header.
  const [nodeTypeCounts, setNodeTypeCounts] = useState<TypeCount[]>([]);
  const [focusedType, setFocusedType] = useState<string | null>(null);
  const [chips, setChips] = useState<string[]>(initialRoute.types);
  // bd-8ub review, should-fix 5: which type's chip (if any) was added BY a
  // focus click, so un-focusing removes only a chip this same mechanism
  // added — a chip already present (added earlier via a search suggestion)
  // must survive un-focusing untouched. Only ever holds the CURRENTLY
  // focused type's own add, or null; see `handleToggleTypeFocus` below.
  const [focusAddedChip, setFocusAddedChip] = useState<string | null>(null);

  /**
   * getStoreSummary().nodeTypes — TypePanel's default-view data and the
   * search bar's suggestion source. Best-effort: a failed fetch just
   * leaves `nodeTypeCounts` as it was (or empty, before the first
   * success), which TypePanel's own "no types yet" empty state already
   * covers. This control is a convenience ranking, not something search
   * or expansion depend on, so a failure here never surfaces as an app-
   * level error.
   */
  async function refreshStoreSummary() {
    try {
      const summary = await trpc.getStoreSummary.query();
      setNodeTypeCounts(summary.nodeTypes);
    } catch {
      // best-effort — see doc comment above
    }
  }

  // Fetched once on mount; `handleNoteCreated`/`handleAnnotated` below
  // call `refreshStoreSummary` again directly after a write that can
  // introduce a brand-new node_type (an edit, edge assert/retract/
  // reweight, or expansion never does — those never create a node).
  useEffect(() => {
    void refreshStoreSummary();
  }, []);

  /**
   * The only caller of the History API (url-addressable-views, design.md
   * decision 2). Skips the write when the URL would not change — the
   * string comparison is encoding-sensitive (`+` vs `%20`), so at worst
   * it lets through a harmless extra `replaceState`; "did the search
   * change" is never decided here but by `isSameSearch`'s value
   * comparison in `applyRoute`. Nothing goes into `history.state`.
   */
  function navigate(route: GraphRoute, mode: "push" | "replace") {
    const url = formatRoute(route);
    if (url === location.pathname + location.search) {
      return;
    }
    if (mode === "push") {
      history.pushState(null, "", url);
    } else {
      history.replaceState(null, "", url);
    }
  }

  /** The current `submittedSearch` with `node` — what every selection-change site replace-writes. */
  function routeFor(node: string | null): GraphRoute {
    return { view: "graph", q: submittedSearch?.q ?? null, types: submittedSearch?.types ?? [], node };
  }

  /**
   * `types` is an explicit argument rather than `chips` read from the
   * closure (url-addressable-views): the deep-link and popstate paths
   * run a search whose chips have not yet been committed to state. The
   * submit path passes `chips`. `history: "push"` is the one place a
   * history entry is added; `"none"` is for a search that was NAVIGATED
   * to, which must not push again. Returns the landed result, or `null`
   * when nothing landed (empty query, no match, or failure), so
   * `applyRoute` can tell "graph replaced" from "nothing changed"
   * without waiting for state to commit.
   */
  async function runSearch(submittedQuery: string, types: string[], opts: { history: "push" | "none" }): Promise<SearchResult | null> {
    const trimmed = submittedQuery.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const generation = ++searchGeneration.current;
    setStatus({ kind: "loading" });
    try {
      // `types.length ? types : undefined`, never `[]`: the server's
      // filterArraySchema() requires nodeTypes to be either absent or a
      // non-empty array (read.ts) — sending `[]` would be a validation
      // error instead of "no filter."
      const result = await trpc.search.query({ query: trimmed, nodeTypes: types.length > 0 ? types : undefined });
      if (generation !== searchGeneration.current) {
        return null; // a later search was asked for while this one was in flight — see `searchGeneration`; the later call owns `status` now
      }
      setStatus({ kind: "done", result });
      // graph-explorer/spec.md's "Query matches nothing" scenario: the
      // canvas stays as it was rather than clearing. Skipping the
      // setGraph call on an empty result — rather than setting it to
      // EMPTY_GRAPH — is what leaves the previous graph (and its now-
      // irrelevant seed highlights) exactly where it was; a genuinely
      // new match fully replaces the graph, which is what actually
      // clears an old highlight (encoding.test.ts: "a new query clears
      // the old highlight").
      if (result.mode !== "empty") {
        // mergeGraphData (bd-hmd.4 review, must-fix), not a plain
        // assignment: searchResultToGraphData builds brand-new node/link
        // objects every call, and force-graph tracks simulation state
        // (x/y/vx/vy) BY OBJECT IDENTITY, mutated directly onto whatever
        // object it was given — a fresh object for a node id that was
        // already on screen has no x/y yet, so d3-force-3d re-randomizes
        // its position, and the node visibly jumps. mergeGraphData
        // reuses the previous render's object for any id still present,
        // so its position survives; see that function's own header for
        // the full trace (react-kapsule's prop-diff -> force-graph's
        // update() -> d3-force-3d's initializeNodes) and why this is
        // also the function bd-hmd.5's expansion will call.
        setGraph((previous) => mergeGraphData(previous, searchResultToGraphData(result)));
        // A fresh query replaces the whole view (unlike expansion, which
        // accumulates) — a node selected before this search may no
        // longer be drawn at all, so the panel closes rather than show
        // stale detail for a node the person can no longer see on
        // screen. Re-select by clicking it again if it's still present.
        setSelectedNodeId(null);
        setDetailExpanded(false);
        // design.md's Open Question, resolved: type focus is a canvas-
        // reading aid for the CURRENT graph, so it clears the same way
        // selectedNodeId does the moment that graph is replaced — never
        // half-applied to a neighbourhood it was never focused against.
        setFocusedType(null);
        // bd-e9n, design.md decision 5: a landed search result fits and
        // centres the view — see GraphCanvas.tsx's `fitRequestId`.
        setFitRequestId((id) => id + 1);
        // url-addressable-views: the address names the search whose
        // result is drawn — set here, and pushed here, nowhere else. An
        // empty result never reaches this branch, so it leaves the URL
        // (and `submittedSearch`) naming the search still on screen.
        setSubmittedSearch({ q: trimmed, types });
        if (opts.history === "push") {
          navigate({ view: "graph", q: trimmed, types, node: null }, "push");
        }
        return result;
      }
      return null;
    } catch (err) {
      if (generation !== searchGeneration.current) {
        return null; // superseded — same as above; the failure belongs to a search nobody is waiting on any more
      }
      // TRPCClientError#message is already the safe, hand-mapped message
      // server/errors.ts built — never a stack trace or connection string.
      const message = err instanceof Error ? err.message : "Search failed unexpectedly.";
      setStatus({ kind: "error", message });
      return null;
    }
  }

  /**
   * Click-to-expand (bd-hmd.5, tasks.md 5.1). `node.id` is the pagination
   * key throughout — see graph/expansion.ts's own header on why a `Map`
   * keyed per node (never a single "current selection" slot) is what
   * makes it structurally impossible for a fetch started for one node to
   * be read, retried, or resolved against a different node's cursor, even
   * if the person clicks a different node while this one is still in
   * flight: that second click looks up ITS OWN id's entry, which is a
   * different Map key entirely.
   */
  async function expandNode(node: GraphNode) {
    const id = node.id;
    if (inFlightExpansions.current.has(id)) {
      return; // a click already in flight for this exact node — see the ref's own comment
    }
    if (!shouldFetchExpansion(expansions, id)) {
      return; // fully expanded already (hasMore false) — clicking again is a no-op, not a wasted re-fetch of page 1
    }
    const cursor = cursorForExpansion(expansions, id); // this node's OWN cursor, never a shared one
    inFlightExpansions.current.add(id);
    setExpansions((previous) => withExpansionLoading(previous, id));
    setExpansionError(null);

    let result;
    try {
      result = await trpc.getNeighbors.query({ id, cursor: cursor ?? undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Expansion failed unexpectedly.";
      setExpansions((previous) => withExpansionError(previous, id, message));
      setExpansionError(`Couldn't expand "${node.title || "(untitled)"}": ${message}`);
      inFlightExpansions.current.delete(id);
      return;
    }
    inFlightExpansions.current.delete(id);

    setExpansions((previous) => withExpansionResult(previous, id, { hasMore: result.hasMore, nextCursor: result.nextCursor }));

    setGraph((previous) => {
      // `result.canonicalId`, not `id`: bd-hmd.1's review made getNeighbors
      // resolve merges and bind its cursor to the CANONICAL id specifically
      // so a cursor can never silently be replayed against the wrong node.
      // Threading that same canonical id through to the edges this merge
      // draws keeps that guarantee's benefit — this app's own ids are
      // already canonical in practice (retrieval and getNeighbors both
      // resolve merges before returning), but relying on the response's
      // own answer rather than assuming it is the whole point of that
      // review fix.
      const parent = previous.nodes.find((n) => n.id === result.canonicalId) as (GraphNode & { x?: number; y?: number }) | undefined;
      const parentPosition = parent && typeof parent.x === "number" && typeof parent.y === "number" ? { x: parent.x, y: parent.y } : undefined;
      return mergeExpansion(previous, { parentId: result.canonicalId, parentPosition, neighbors: result.neighbors });
    });
    // bd-e9n, design.md decision 5, review follow-up: expansion does NOT
    // bump `fitRequestId` — see that state's own doc comment above. An
    // earlier version did, which re-fit the whole view on the first
    // click of ANY node (the settle path fires whether or not the fetch
    // actually added anything); a fit now happens only when a search
    // result lands, in `runSearch` below.
  }

  /**
   * Select + expand, and NOTHING about the URL (url-addressable-views,
   * design.md decision 2). `applyRoute` calls this for a selection it
   * derived FROM the URL — a replace-write there would be redundant at
   * best, and wrong right after `await runSearch(...)`, where this
   * render's `submittedSearch` is still the previous search: it would
   * emit the old query with the new node.
   */
  function selectNode(node: GraphNode) {
    setSelectedNodeId(node.id);
    setDetailExpanded(false); // bd-e9n: a newly selected node always opens as a summary, even if the previously selected one was expanded
    void expandNode(node);
  }

  /** "A click both expands and selects" — see this file's header — and, url-addressable-views, replace-writes the selection into the address (never a push: see the header). */
  function handleNodeClick(node: GraphNode) {
    selectNode(node);
    navigate(routeFor(node.id), "replace");
  }

  /** A content/title edit was saved (DetailPanel's ContentSection) — patch the canvas node's own title so it's reflected without a re-search. */
  function handleContentSaved(nodeId: string, newTitle: string) {
    setGraph((previous) => mergeNodePatch(previous, nodeId, { title: newTitle }));
  }

  /**
   * An annotation was created (DetailPanel's AnnotateSection, task 6.3).
   * Reuses `mergeExpansion` verbatim via a synthesized single-neighbor
   * page (`buildAnnotationNeighbor`) — the ticket's own instruction: "add
   * nodes without moving anything ... reuse [mergeExpansion] rather than
   * inventing a second path."
   *
   * `newTargetDegree` is captured HERE, from `target.degree` — before
   * `setGraph`'s updater runs, not from inside it — and handed to
   * `setNodeDegree` as an absolute value. That ordering is load-bearing,
   * not stylistic: `setGraph`'s updater runs twice under React
   * StrictMode (a documented dev-only purity check), and an earlier
   * version of this handler read `target.degree` and bumped it by 1
   * *inside* the updater, which this ticket's own end-to-end run (task
   * 6.7) caught landing on +2 — see `setNodeDegree`'s header in
   * encoding.ts for the full trace.
   */
  function handleAnnotated(target: GraphNode, result: AnnotateResult, title: string | undefined) {
    const newTargetDegree = target.degree + 1; // exact, not a guess — the note is brand new, so it was provably not already counted
    setGraph((previous) => {
      const parent = previous.nodes.find((n) => n.id === target.id) as (GraphNode & { x?: number; y?: number }) | undefined;
      const parentPosition = parent && typeof parent.x === "number" && typeof parent.y === "number" ? { x: parent.x, y: parent.y } : undefined;
      const merged = mergeExpansion(previous, { parentId: target.id, parentPosition, neighbors: [buildAnnotationNeighbor(result, title)] });
      setNodeDegree(merged.nodes, target.id, newTargetDegree);
      return merged;
    });
    // Outside the updater, deliberately — see this function's own doc
    // comment on why the updater above runs twice under StrictMode; a
    // network call triggered from inside it would double-fire the same
    // way the degree bug did before setNodeDegree took an absolute value.
    void refreshStoreSummary(); // a fresh note can carry a brand-new node_type (bd-14q/bd-73t)
  }

  /** A hand edge was asserted between two nodes already on screen (DetailPanel's ConnectForm, task 6.5). */
  function handleEdgeAsserted(input: { srcId: string; dstId: string; edgeType: string; weight?: number }, result: AssertResult) {
    setGraph((previous) => mergeAssertedEdge(previous, buildAssertedLink(result, input)));
  }

  /** A hand edge was retracted (DetailPanel's EdgeRow, task 6.5). */
  function handleEdgeRetracted(linkId: string) {
    setGraph((previous) => mergeRetractedEdge(previous, linkId));
  }

  /** A hand edge was reweighted (DetailPanel's EdgeRow, task 6.5). */
  function handleEdgeReweighted(linkId: string, weight: number) {
    setGraph((previous) => mergeReweightedEdge(previous, linkId, weight));
  }

  /** A standalone note was created (CreateNoteForm, task 6.4) — draws it (degree 0, no edges) and opens its detail. */
  function handleNoteCreated(result: CreateNoteResult, title: string | undefined) {
    const node = buildStandaloneNoteNode(result, title);
    setGraph((previous) => mergeStandaloneNode(previous, node));
    setSelectedNodeId(result.id);
    setDetailExpanded(false); // bd-e9n: opens as a summary, same as any other selection
    navigate(routeFor(result.id), "replace"); // url-addressable-views: a selection change, so a replace
    closeNoteForm();
    void refreshStoreSummary(); // a fresh note can carry a brand-new node_type (bd-14q/bd-73t)
  }

  /** A previously-unlinked note was chosen from the list (UnlinkedNotes, task 6.4) — draws it and opens its detail, same as a freshly created one. */
  function handleShowUnlinkedNote(note: UnlinkedNote) {
    const node = graphNodeFromUnlinkedNote(note);
    setGraph((previous) => mergeStandaloneNode(previous, node));
    setSelectedNodeId(note.id);
    setDetailExpanded(false); // bd-e9n: opens as a summary, same as any other selection
    navigate(routeFor(note.id), "replace"); // url-addressable-views: a selection change, so a replace
  }

  /**
   * The one path that turns a URL into explorer state — a deep link on
   * mount and a back/forward step both come through here, so they cannot
   * drift (url-addressable-views, design.md decisions 3 and 4).
   *
   *   1. Box and chips always show what the URL says. Type focus clears
   *      with them (review follow-up): a focus-added chip may have just
   *      vanished from the bar, and TypePanel must not keep showing its
   *      row pressed for a chip that is no longer there.
   *   2. No `q`: `submittedSearch` clears. With no `node` either, so does
   *      the canvas (review follow-up) — exactly what a fresh load of this
   *      URL shows (the spec's "filters alone, with no query" scenario),
   *      so a back step to the first entry matches a reload of it instead
   *      of leaving the previous search drawn under an address that no
   *      longer names it; with a `node`, the current graph is kept for
   *      step 4 to find it in. Same search as drawn (a VALUE comparison
   *      against `submittedSearch`, never a URL string): skip it — this
   *      is the "only the selection changed" scenario, and why back/
   *      forward between selections is cheap. Otherwise run it with
   *      `history: "none"` (it was navigated to; pushing again would
   *      double the entry), and read the RESULT for the node lookup:
   *      `setGraph` has not committed when `runSearch` returns — the same
   *      reason `handleAnnotated` captures `target.degree` before its
   *      updater runs. An empty result stops here: the spec's "nothing
   *      matched" behaviour is unchanged and the URL already is what it is.
   *   3. No `node`: deselect. `node` already selected and the graph not
   *      replaced: do nothing — `expandNode` with an existing cursor
   *      fetches the NEXT page, so re-selecting would silently pull extra
   *      neighbours on a step that changed nothing.
   *   4. `node` in the result (or the current graph): `selectNode`, so a
   *      deep link looks exactly like a click — minus the URL write, which
   *      the URL already is. Not in it: `getNodes`, and draw the node on
   *      its own through `graphNodeFromUnlinkedNote` + `mergeStandaloneNode`
   *      (the `handleShowUnlinkedNote` path; the lookup DTO carries
   *      id/title/type/source/isEditable and is accepted structurally). The
   *      lookup has no `degree`, so such a node draws at the minimum radius
   *      and reads degree 0 until a search returns it — accepted, since
   *      adding `degree` to the lookup is a server change this change
   *      excludes. A merged-away id resolves to its survivor, whose id then
   *      replaces the URL's. `notFoundIds`, or a failed call: nothing
   *      selected, the expansion-error toast says so (review follow-up: a
   *      dead link must not fail silently, and user copy never repeats the
   *      raw UUID — it is in the address bar), and the URL is replaced
   *      without `node` so a bad id does not survive a reload.
   *
   * Two guards around the awaits (review follow-up). `routeGeneration`:
   * after each `await`, a route that a later call has superseded returns
   * without another `set*` or `navigate` — see the ref's own comment. And
   * once a re-run search has landed, every terminal branch re-asserts the
   * applied route with a replace-write: normally a no-op through
   * `navigate`'s equal-URL skip, it repairs the one case a generation
   * cannot see — a node click landing DURING the in-flight search, which
   * replace-wrote the previous `submittedSearch` with the new node
   * (`routeFor` reads its render's closure) and would otherwise leave the
   * address disagreeing with the canvas until the next click.
   */
  async function applyRoute(route: GraphRoute): Promise<void> {
    const generation = ++routeGeneration.current;
    setQuery(route.q ?? "");
    setChips(route.types);
    setFocusedType(null);
    setFocusAddedChip(null);

    let nodes = graph.nodes;
    let replaced = false;
    if (route.q === null) {
      setSubmittedSearch(null);
      if (route.node === null) {
        setGraph(EMPTY_GRAPH);
        setStatus({ kind: "idle" });
      }
    } else if (!isSameSearch(submittedSearch, route)) {
      const result = await runSearch(route.q, route.types, { history: "none" });
      if (generation !== routeGeneration.current || !result) {
        return;
      }
      nodes = searchResultToGraphData(result).nodes;
      replaced = true;
    }

    if (route.node === null) {
      setSelectedNodeId(null);
      setDetailExpanded(false);
      if (replaced) {
        navigate(route, "replace");
      }
      return;
    }
    if (!replaced && route.node === selectedNodeId) {
      return;
    }

    const found = nodes.find((n) => n.id === route.node);
    if (found) {
      selectNode(found);
      if (replaced) {
        navigate(route, "replace");
      }
      return;
    }

    let lookedUp;
    let lookupFailure: string | null = null;
    try {
      const lookup = await trpc.getNodes.query({ ids: [route.node] });
      lookedUp = lookup.nodes[0];
    } catch (err) {
      lookupFailure = err instanceof Error ? err.message : "Lookup failed unexpectedly.";
    }
    if (generation !== routeGeneration.current) {
      return;
    }
    if (!lookedUp) {
      setExpansionError(lookupFailure === null ? "That node no longer exists." : `Couldn't open the linked node: ${lookupFailure}`);
      setSelectedNodeId(null);
      setDetailExpanded(false);
      navigate({ ...route, node: null }, "replace");
      return;
    }
    const node = graphNodeFromUnlinkedNote(lookedUp);
    setGraph((previous) => mergeStandaloneNode(previous, node));
    selectNode(node);
    // The survivor's id when a merged-away id resolved; otherwise this IS
    // `route`, and the re-assert described above.
    navigate({ ...route, node: lookedUp.id }, "replace");
  }

  // No dependency array, on purpose: the ref must hold THIS render's
  // `applyRoute` (see the ref's own comment), and a dependency list that
  // named everything it closes over would just be a longer way of saying
  // "every render."
  useEffect(() => {
    applyRouteRef.current = applyRoute;
  });

  // The initial route (design.md decisions 3 and 5): an unknown path
  // (`/`, a stale bookmark) is replaced — never pushed, so it is never a
  // back stop — with `/graph` carrying the same query string, then applied
  // as if that had been the URL. Calls `applyRoute` directly rather than
  // through the ref: on the first render `graph` is empty and
  // `submittedSearch` null, which is exactly the state a fresh mount is in.
  useEffect(() => {
    if (didApplyInitialRoute.current) {
      return;
    }
    didApplyInitialRoute.current = true;
    const parsed = parseRoute(location.pathname, location.search);
    const route = parsed ?? graphRouteFromSearch(location.search);
    if (parsed === null) {
      navigate(route, "replace");
    }
    void applyRoute(route);
  }, []);

  // Back/forward (design.md decision 3): the listener body reads no state
  // of its own — it parses `location` and hands the route to the CURRENT
  // `applyRoute` through the ref, which is the only reason the listener
  // can be registered once and left alone.
  useEffect(() => {
    function handlePopState() {
      const route = parseRoute(location.pathname, location.search) ?? graphRouteFromSearch(location.search);
      void applyRouteRef.current?.(route);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  /**
   * TypePanel row click (bd-14q). Reads `focusedType` from this render's
   * own closure rather than from inside a `setFocusedType` updater —
   * this is a plain event handler, not one nested inside another state
   * updater, so the closure is safe (see `handleAnnotated`'s comment for
   * the pattern this deliberately avoids). Turning focus ON also adds the
   * chip; turning it OFF (clicking the already-focused row) removes it —
   * design.md: "one mechanism for 'filter by this type'", reachable from
   * either this control or the search bar's own suggestions (task 4.5).
   *
   * bd-8ub review, should-fix 5: turning focus OFF must remove the chip
   * ONLY if turning it ON is what added it — `focusAddedChip` (read from
   * this render's own closure, same reasoning as `turningOn` above) is
   * how that's known. A chip already present when focus turned on (added
   * earlier via a search suggestion) is never this handler's to remove.
   */
  function handleToggleTypeFocus(nodeType: string) {
    const turningOn = focusedType !== nodeType;
    setFocusedType(turningOn ? nodeType : null);
    if (turningOn) {
      // Switching straight from one focused type to another must not strand
      // the previous type's focus-added chip.
      const stranded = focusAddedChip !== null && focusAddedChip !== nodeType ? focusAddedChip : null;
      const alreadyChipped = chips.includes(nodeType);
      setFocusAddedChip(alreadyChipped ? null : nodeType);
      setChips((previous) => {
        const kept = stranded === null ? previous : previous.filter((c) => c !== stranded);
        return alreadyChipped ? kept : [...kept, nodeType];
      });
    } else {
      if (focusAddedChip === nodeType) {
        setChips((previous) => previous.filter((c) => c !== nodeType));
      }
      setFocusAddedChip(null);
    }
  }

  /** A type suggestion was chosen from the search bar's dropdown (bd-73t) — adds the chip and clears the typed substring (design.md). */
  function handleChooseSuggestion(nodeType: string) {
    setChips((previous) => (previous.includes(nodeType) ? previous : [...previous, nodeType]));
    setQuery("");
  }

  /** A chip's own remove button was activated (bd-73t). */
  function handleRemoveChip(nodeType: string) {
    setChips((previous) => previous.filter((c) => c !== nodeType));
  }

  // The selected node's on-screen neighbour-type ranking (bd-14q) — a
  // plain derived value computed every render, never a `useEffect`:
  // `rankNeighborTypes` is a pure O(nodes + links) function over state
  // already held (`graph`), bounded by the same nodeBudget the graph
  // itself is, so recomputing it on every render is cheap enough not to
  // warrant memoizing.
  const selectedNode = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) : undefined;
  const typePanelSelection = selectedNode ? { title: selectedNode.title || "(untitled)", ranked: rankNeighborTypes(selectedNode.id, graph.nodes, graph.links) } : null;

  // Search-bar type suggestions (bd-73t) — matchNodeTypes's own 2-arg
  // contract excludes nothing; already-chosen chips are filtered out
  // HERE, at the call site, per that function's own header.
  const typeSuggestions = matchNodeTypes(query, nodeTypeCounts).filter((t) => !chips.includes(t.nodeType));

  /**
   * Store-wide type-colour rank map (bd-4ye, design.md decision 2) —
   * `nodeTypeCounts` ranked by count desc/name-asc (the SAME
   * `topStoreTypes` comparator TypePanel's own default view already
   * uses, reused rather than re-sorting a second way) and mapped onto
   * palette.ts's categorical palette in that order. `useMemo`, not an
   * effect: this is a pure derivation of state already held, recomputed
   * only when `nodeTypeCounts` itself changes identity (on load, and
   * after a write that could introduce a new node_type — the same
   * cadence `refreshStoreSummary` already follows). Passed to
   * GraphCanvas, TypePanel, and SearchBar so none of them can disagree
   * about what colour a type is.
   */
  const typeColors = useMemo(() => {
    const rankedTypeNames = topStoreTypes(nodeTypeCounts, nodeTypeCounts.length).map((t) => t.nodeType);
    return assignTypeColors(rankedTypeNames);
  }, [nodeTypeCounts]);

  // Right column width + GraphCanvas's `insetRight` (bd-e9n, design.md
  // decision 5) — a plain derivation of state already held, computed
  // during render like `typePanelSelection`/`typeSuggestions` above, no
  // effect and no DOM measurement (GraphCanvas's own doc comment on why
  // a prop, not a ResizeObserver, is the right shape for this).
  //
  // The right column is ONE shared flex column (TypePanel, then
  // DetailPanel when a node is selected) — task instruction: "the type
  // control column should size to the detail panel's current width so
  // the column stays aligned." So the column's width follows
  // DetailPanel's own w-80 (summary)/w-96 (expanded) sizing exactly,
  // defaulting to the narrower w-80 when nothing is selected (the same
  // width a freshly opened panel would start at).
  const rightColumnExpanded = Boolean(selectedNodeId) && detailExpanded;
  const rightColumnWidthClass = rightColumnExpanded ? "w-96" : "w-80";
  const rightColumnWidthPx = rightColumnExpanded ? RIGHT_COLUMN_EXPANDED_WIDTH_PX : RIGHT_COLUMN_SUMMARY_WIDTH_PX;
  // The type control panel is always present when the store has any
  // types (task instruction) — an empty store's "no types yet" panel
  // contributes nothing to protect the fit from, so an empty
  // `nodeTypeCounts` with no node selected leaves insetRight at 0, "no
  // panels open," matching GraphCanvas's own `insetRight` doc comment.
  const rightColumnOpen = nodeTypeCounts.length > 0 || Boolean(selectedNodeId);
  const insetRight = rightColumnOpen ? RIGHT_COLUMN_OFFSET_PX + rightColumnWidthPx : 0;

  return (
    <div className="h-dvh w-screen overflow-hidden">
      {/*
        Empty-state ambience (bd-8ub review, immersive brief item 11): a
        static vignette + sparse starfield, `-z-10` so it always sits
        behind the canvas (whose own `backgroundColor` is now transparent
        — see GraphCanvas.tsx's CANVAS_BACKGROUND_COLOR) and every panel.
        `.ambience` (index.css) is plain CSS `background-image` —
        `prefers-reduced-motion` is satisfied trivially by there being
        nothing to reduce, not by a media-query branch.
      */}
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />

      {/* The map is the page (design.md) — the canvas's own fixed, full-viewport layer, sized independently of every panel below. */}
      <div className="fixed inset-0">
        <GraphCanvas
          data={graph}
          onNodeExpand={handleNodeClick}
          expandableNodeIds={expandableNodeIds(expansions)}
          focusedNodeType={focusedType}
          typeColors={typeColors}
          selectedNodeId={selectedNodeId}
          insetRight={insetRight}
          fitRequestId={fitRequestId}
        />
      </div>

      {/* Top-center: search bar + "New note" popover. */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-20 flex justify-center px-4">
        <div className="pointer-events-auto">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            onSubmit={(q) => void runSearch(q, chips, { history: "push" })}
            status={status}
            suggestions={typeSuggestions}
            chips={chips}
            onChooseSuggestion={handleChooseSuggestion}
            onRemoveChip={handleRemoveChip}
            typeColors={typeColors}
            // url-addressable-views review follow-up: a deep link WITH a
            // node is asking for the panel, not the box — DetailPanel moves
            // focus to its own heading on open, and the box's autoFocus
            // would otherwise take focus first only to have it yanked away
            // ~1s later when the route-applied selection lands.
            autoFocus={initialRoute.node === null}
            trailing={
              <div className="relative shrink-0">
                <button
                  ref={newNoteButtonRef}
                  type="button"
                  onClick={() => setNoteFormOpen((open) => !open)}
                  aria-expanded={noteFormOpen}
                  aria-controls={NOTE_POPOVER_ID}
                  className="rounded-xl border border-hairline px-3 py-2 text-sm font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  + New note
                </button>
                {noteFormOpen && (
                  <div
                    id={NOTE_POPOVER_ID}
                    ref={noteFormRef}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        closeNoteForm();
                      }
                    }}
                    className="glass absolute top-full right-0 z-30 mt-2 w-80 p-3"
                  >
                    <CreateNoteForm autoOpen onCreated={handleNoteCreated} onCancel={closeNoteForm} />
                  </div>
                )}
              </div>
            }
          />
        </div>
      </div>

      {/*
        Top-right column: type control (TypePanel) with the detail panel
        below it. Width tracks the detail panel's own summary/expanded
        state (bd-e9n, design.md decision 6) rather than a fixed `w-96` —
        see `rightColumnWidthClass`'s own comment above — so the column
        never has a gap between its own edge and DetailPanel's.
      */}
      <div className={`pointer-events-none fixed top-4 right-4 bottom-4 z-10 flex ${rightColumnWidthClass} flex-col items-stretch gap-3`}>
        <div className="glass pointer-events-auto shrink-0 p-3">
          <TypePanel storeTypes={nodeTypeCounts} selected={typePanelSelection} focusedType={focusedType} onToggleFocus={handleToggleTypeFocus} typeColors={typeColors} />
        </div>
        {selectedNodeId && (
          <div className="pointer-events-auto min-h-0 flex-1">
            <DetailPanel
              key={selectedNodeId}
              nodeId={selectedNodeId}
              allNodes={graph.nodes}
              allLinks={graph.links}
              onClose={() => {
                setSelectedNodeId(null);
                setDetailExpanded(false);
                navigate(routeFor(null), "replace"); // url-addressable-views: a selection change, so a replace
              }}
              onExpandedChange={setDetailExpanded}
              onContentSaved={handleContentSaved}
              onAnnotated={handleAnnotated}
              onEdgeAsserted={handleEdgeAsserted}
              onEdgeRetracted={handleEdgeRetracted}
              onEdgeReweighted={handleEdgeReweighted}
            />
          </div>
        )}
      </div>

      {/* Bottom-left: unlinked-notes disclosure. Deliberately not gated on a search result: a standalone note can be created, and an unlinked one found, with nothing on screen at all. */}
      <div className="pointer-events-none fixed bottom-4 left-4 z-20">
        <div className="pointer-events-auto">
          <UnlinkedNotes onShow={handleShowUnlinkedNote} />
        </div>
      </div>

      {/* Bottom-center: expansion-error toast (used to be an inline banner under the header). */}
      {expansionError && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div role="alert" className="glass pointer-events-auto max-w-md px-4 py-2 text-sm text-red-300">
            {expansionError}
          </div>
        </div>
      )}
    </div>
  );
}
