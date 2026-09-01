// Plain-list rendering of a search result (bd-hmd.3, tasks.md 3.7). No
// graph — that's bd-hmd.4. Each row shows what the spec's "Search returns
// renderable results" scenario asks for: title, node type, source
// system, degree, and score.
//
// `node.isEditable` comes from the server, which computed it with
// `isEditableSourceSystem` — see server/dto.ts's header for why the
// client imports the server's computed boolean rather than the function
// itself (that barrel import would pull the `pg` driver into this
// bundle). This component still never re-derives the rule locally.

import type { trpc } from "../trpc.js";

// Derived directly from the live client, not hand-typed — this is the
// same end-to-end inference the ticket proves elsewhere: a shape change
// on the server changes this type with no schema-generation step.
export type SearchResult = Awaited<ReturnType<typeof trpc.search.query>>;
export type SearchResultNode = SearchResult extends { nodes: readonly (infer N)[] } ? N : never;

function ScoreBadge({ score }: { score: number }) {
  return <span className="tabular-nums text-xs font-medium text-slate-500">{score.toFixed(4)}</span>;
}

function ResultRow({ node }: { node: SearchResultNode }) {
  const editable = node.isEditable;

  return (
    <li className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3 last:border-b-0 hover:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-slate-900">{node.title || "(untitled)"}</span>
          {node.isSeed && <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700">seed</span>}
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              editable ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
            }`}
          >
            {editable ? "editable" : "read-only"}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
          <span>
            type: <span className="font-mono">{node.nodeType}</span>
          </span>
          <span>
            source: <span className="font-mono">{node.sourceSystem}</span>
          </span>
          <span>degree: {node.degree}</span>
        </div>
        {node.snippet && (
          <p
            className="mt-1 truncate text-xs text-slate-400 [&_mark]:bg-yellow-100 [&_mark]:text-slate-700"
            // The snippet is server-generated ts_headline output (plain
            // `[[`/`]]` delimiters, converted to <mark> below) — never
            // raw stored content rendered as HTML.
            dangerouslySetInnerHTML={{ __html: node.snippet.replaceAll("[[", "<mark>").replaceAll("]]", "</mark>") }}
          />
        )}
      </div>
      <ScoreBadge score={node.score} />
    </li>
  );
}

export function SearchResultsList({ result }: { result: SearchResult | null }) {
  if (result === null) {
    return <p className="px-1 py-6 text-center text-sm text-slate-400">Search to see results.</p>;
  }

  if (result.mode === "empty") {
    return (
      <p className="px-1 py-6 text-center text-sm text-slate-400">
        No matches. Tried both search modes: {result.triedModes.join(" and ")}.
      </p>
    );
  }

  if (result.nodes.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-slate-400">No matches.</p>;
  }

  return (
    <div>
      <p className="px-1 pb-2 text-xs text-slate-500">
        {result.mode} match — {result.seedCount} seed{result.seedCount === 1 ? "" : "s"}, {result.nodeCount} node{result.nodeCount === 1 ? "" : "s"}
        {result.truncated ? " (truncated by nodeBudget)" : ""}
      </p>
      <ul className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {result.nodes.map((node) => (
          <ResultRow key={node.id} node={node} />
        ))}
      </ul>
    </div>
  );
}
