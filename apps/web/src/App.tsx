// Search box, submitted query, results as a plain list (bd-hmd.3, tasks.md
// 3.7). No graph — that's bd-hmd.4.

import { useState } from "react";
import { SearchResultsList, type SearchResult } from "./components/SearchResultsList.js";
import { trpc } from "./trpc.js";

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: SearchResult };

export function App() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function runSearch(submittedQuery: string) {
    const trimmed = submittedQuery.trim();
    if (trimmed.length === 0) {
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const result = await trpc.search.query({ query: trimmed });
      setStatus({ kind: "done", result });
    } catch (err) {
      // TRPCClientError#message is already the safe, hand-mapped message
      // server/errors.ts built — never a stack trace or connection string.
      const message = err instanceof Error ? err.message : "Search failed unexpectedly.";
      setStatus({ kind: "error", message });
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-6 py-10">
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

      <div className="mt-6">
        {status.kind === "error" && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>}
        {status.kind === "idle" && <SearchResultsList result={null} />}
        {status.kind === "loading" && <p className="px-1 py-6 text-center text-sm text-slate-400">Searching…</p>}
        {status.kind === "done" && <SearchResultsList result={status.result} />}
      </div>
    </div>
  );
}
