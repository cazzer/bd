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

interface SnippetSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Splits `ts_headline`'s `[[matched]]` delimiters (StartSel/StopSel,
 * configured in packages/core/src/retrieval.ts) into segments for plain
 * React rendering — bd-hmd.3 review, stored XSS: `ts_headline` wraps
 * *matched* lexemes in `[[`/`]]` but does not HTML-escape the rest of
 * the snippet, and nothing in core rejects `<`/`>` in title/content (only
 * C0 control characters are blocked — see nodes.ts's `findControlChar`).
 * A title of `xsstest <img src=x onerror=alert(1)>` therefore came back
 * byte-for-byte in `snippet` and, via the `dangerouslySetInnerHTML` this
 * replaces, executed in the page with the tRPC client's full access.
 *
 * This function does no HTML parsing at all — it only recognizes the two
 * literal delimiter strings and splits on them. Every other character,
 * `<`/`>` included, becomes part of a segment's `text` and is rendered
 * below as JSX text content, which React escapes unconditionally. There
 * is no code path from ingested content to executed markup here anymore.
 */
function parseSnippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const parts = snippet.split(/(\[\[|\]\])/);
  let highlighted = false;
  for (const part of parts) {
    if (part === "[[") {
      highlighted = true;
      continue;
    }
    if (part === "]]") {
      highlighted = false;
      continue;
    }
    if (part.length > 0) {
      segments.push({ text: part, highlighted });
    }
  }
  return segments;
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
          <p className="mt-1 truncate text-xs text-slate-400">
            {parseSnippetSegments(node.snippet).map((segment, i) =>
              segment.highlighted ? (
                <mark key={i} className="bg-yellow-100 text-slate-700">
                  {segment.text}
                </mark>
              ) : (
                <span key={i}>{segment.text}</span>
              ),
            )}
          </p>
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
