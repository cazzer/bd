// Search box, submitted query, results as a force-directed graph canvas
// (bd-hmd.4). Was a plain list (bd-hmd.3, tasks.md 3.7) — see
// graph/encoding.ts for the search-result -> graph-data transform this
// replaces SearchResultsList.tsx's rendering with. Expansion on click is
// bd-hmd.5, not this ticket: the graph is search-driven only.

import { useState } from "react";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { GraphLegend } from "./components/GraphLegend.js";
import { EMPTY_GRAPH, searchResultToGraphData, type GraphCanvasData, type SearchResult } from "./graph/encoding.js";
import { trpc } from "./trpc.js";

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: SearchResult };

export function App() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [graph, setGraph] = useState<GraphCanvasData>(EMPTY_GRAPH);

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
        setGraph(searchResultToGraphData(result));
      }
    } catch (err) {
      // TRPCClientError#message is already the safe, hand-mapped message
      // server/errors.ts built — never a stack trace or connection string.
      const message = err instanceof Error ? err.message : "Search failed unexpectedly.";
      setStatus({ kind: "error", message });
    }
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
      </div>

      <div className="mx-auto mt-4 flex w-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200">
        <div className="min-h-0 flex-1">
          <GraphCanvas data={graph} />
        </div>
        <GraphLegend />
      </div>
    </div>
  );
}
