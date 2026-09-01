// Search box, submitted query, results as a force-directed graph canvas
// (bd-hmd.4), click-to-expand (bd-hmd.5, see graph/expansion.ts for the
// merge/pin/pagination logic this component only orchestrates), and node
// detail/editing/annotation/hand edges (bd-hmd.6).
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

import { useRef, useState } from "react";
import { CreateNoteForm } from "./components/CreateNoteForm.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { GraphLegend } from "./components/GraphLegend.js";
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
import { trpc } from "./trpc.js";

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: SearchResult };

type AnnotateResult = Awaited<ReturnType<typeof trpc.annotateNode.mutate>>;
type AssertResult = Awaited<ReturnType<typeof trpc.assertEdge.mutate>>;
type CreateNoteResult = Awaited<ReturnType<typeof trpc.createNote.mutate>>;

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
  // Concurrency guard for expandNode, deliberately NOT React state (bd-hmd.1's
  // review, reapplied to this UI — see the ticket report): two clicks on the
  // SAME node fired in the same tick would both read the same, not-yet-
  // re-rendered `expansions` snapshot and both pass `shouldFetchExpansion`,
  // since a `useState` update is only visible after the next render commits.
  // A ref is mutated (and checked) synchronously, so the second click sees
  // the first's "in flight" mark immediately — no re-render required.
  const inFlightExpansions = useRef<Set<string>>(new Set());

  async function runSearch(submittedQuery: string) {
    const trimmed = submittedQuery.trim();
    if (trimmed.length === 0) {
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const result = await trpc.search.query({ query: trimmed });
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
  }

  /** "A click both expands and selects" — see this file's header. */
  function handleNodeClick(node: GraphNode) {
    setSelectedNodeId(node.id);
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
  }

  /** A previously-unlinked note was chosen from the list (UnlinkedNotes, task 6.4) — draws it and opens its detail, same as a freshly created one. */
  function handleShowUnlinkedNote(note: UnlinkedNote) {
    const node = graphNodeFromUnlinkedNote(note);
    setGraph((previous) => mergeStandaloneNode(previous, node));
    setSelectedNodeId(note.id);
  }

  return (
    <div className="flex h-screen flex-col px-6 py-6">
      <div className="mx-auto w-full max-w-3xl shrink-0">
        <h1 className="text-2xl font-semibold text-slate-900">breakdown</h1>
        <p className="mt-1 text-sm text-slate-500">Search the local knowledge store.</p>

        <form
          className="mt-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(query);
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search the knowledge store"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            autoFocus
          />
          <button
            type="submit"
            disabled={status.kind === "loading"}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {status.kind === "loading" ? "Searching…" : "Search"}
          </button>
        </form>

        <div className="mt-4 min-h-[1.5rem]">
          {status.kind === "idle" && <p className="text-sm text-slate-400">Search to see the graph.</p>}
          {status.kind === "loading" && <p className="text-sm text-slate-400">Searching…</p>}
          {status.kind === "error" && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>}
          {status.kind === "done" && status.result.mode === "empty" && (
            <p className="text-sm text-slate-400">No matches. Tried both search modes: {status.result.triedModes.join(" and ")}.</p>
          )}
          {status.kind === "done" && status.result.mode !== "empty" && (
            <p className="text-xs text-slate-500">
              {status.result.mode} match — {status.result.seedCount} seed{status.result.seedCount === 1 ? "" : "s"}, {status.result.nodeCount} node
              {status.result.nodeCount === 1 ? "" : "s"}
              {status.result.truncated ? " (truncated by nodeBudget)" : ""}
            </p>
          )}
        </div>

        {/* Node creation/discovery (bd-hmd.6, task 6.4) — deliberately not
            gated on a search result: a standalone note can be created, and
            an unlinked one found, with nothing on screen at all. */}
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <CreateNoteForm onCreated={handleNoteCreated} />
          <UnlinkedNotes onShow={handleShowUnlinkedNote} />
        </div>
      </div>

      {expansionError && (
        <div className="mx-auto mt-2 w-full max-w-3xl shrink-0">
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{expansionError}</p>
        </div>
      )}

      <div className="mx-auto mt-4 flex w-full min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
            <GraphCanvas data={graph} onNodeExpand={handleNodeClick} expandableNodeIds={expandableNodeIds(expansions)} />
          </div>
          <GraphLegend />
        </div>
        {selectedNodeId && (
          <DetailPanel
            key={selectedNodeId}
            nodeId={selectedNodeId}
            allNodes={graph.nodes}
            allLinks={graph.links}
            onClose={() => setSelectedNodeId(null)}
            onContentSaved={handleContentSaved}
            onAnnotated={handleAnnotated}
            onEdgeAsserted={handleEdgeAsserted}
            onEdgeRetracted={handleEdgeRetracted}
            onEdgeReweighted={handleEdgeReweighted}
          />
        )}
      </div>
    </div>
  );
}
