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

export function App() {
  const [query, setQuery] = useState("");
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
  const [chips, setChips] = useState<string[]>([]);
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

  async function runSearch(submittedQuery: string) {
    const trimmed = submittedQuery.trim();
    if (trimmed.length === 0) {
      return;
    }
    setStatus({ kind: "loading" });
    try {
      // `chips.length ? chips : undefined`, never `[]`: the server's
      // filterArraySchema() requires nodeTypes to be either absent or a
      // non-empty array (read.ts) — sending `[]` would be a validation
      // error instead of "no filter."
      const result = await trpc.search.query({ query: trimmed, nodeTypes: chips.length > 0 ? chips : undefined });
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
      }
    } catch (err) {
      // TRPCClientError#message is already the safe, hand-mapped message
      // server/errors.ts built — never a stack trace or connection string.
      const message = err instanceof Error ? err.message : "Search failed unexpectedly.";
      setStatus({ kind: "error", message });
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

  /** "A click both expands and selects" — see this file's header. */
  function handleNodeClick(node: GraphNode) {
    setSelectedNodeId(node.id);
    setDetailExpanded(false); // bd-e9n: a newly selected node always opens as a summary, even if the previously selected one was expanded
    void expandNode(node);
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
    closeNoteForm();
    void refreshStoreSummary(); // a fresh note can carry a brand-new node_type (bd-14q/bd-73t)
  }

  /** A previously-unlinked note was chosen from the list (UnlinkedNotes, task 6.4) — draws it and opens its detail, same as a freshly created one. */
  function handleShowUnlinkedNote(note: UnlinkedNote) {
    const node = graphNodeFromUnlinkedNote(note);
    setGraph((previous) => mergeStandaloneNode(previous, node));
    setSelectedNodeId(note.id);
    setDetailExpanded(false); // bd-e9n: opens as a summary, same as any other selection
  }

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
            onSubmit={(q) => void runSearch(q)}
            status={status}
            suggestions={typeSuggestions}
            chips={chips}
            onChooseSuggestion={handleChooseSuggestion}
            onRemoveChip={handleRemoveChip}
            typeColors={typeColors}
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
