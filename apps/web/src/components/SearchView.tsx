// The search results view (search-results-view, design.md decisions 6 and
// 7): one address-held list of nodes, narrowed by node type, project, and
// reviews only. Mounted lazily by the shell (App.tsx) under `/search`; the
// text and filters live in the address (lib/route.ts), so a reload, a
// shared link, and back/forward all show the same results. Read-only.
//
// One `find` call per page answers both the rows and the facet counts.
// The first page is re-fetched whenever the route changes (keyed on its
// formatted address, the same string `navigate` compares); "Load more"
// asks for the next page at the server's `nextOffset` — never offset plus
// limit, since the server's response budget can drop rows from the tail —
// and drops the answer if the route moved on meanwhile (FeedView's
// guard). Facets stay those of the first page: they count every match,
// not the page, so a later page would only repeat them.
//
// Filters `replace` the address and a text submit `push`es one
// (search-results/spec.md, "Results are held in the address"). A result
// is a real link (`href` from lib/searchRow.ts's `resultRoute`) so it can
// be middle-clicked or copied; a plain click goes through `navigate`. A
// snippet's `[[ ]]` highlights are split by `parseSnippetSegments` and
// rendered as JSX text, never markup (lib/snippet.ts on why).

import { useEffect, useState, type MouseEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type Route, type SearchRoute } from "../lib/route.js";
import {
  facetOptions,
  findInputFor,
  openInGraphRoute,
  resultRoute,
  rowStatus,
  searchRouteFor,
  toggleProject,
  toggleType,
  withReviewsOnly,
  type FacetOption,
  type FindResult,
  type FoundRow,
} from "../lib/searchRow.js";
import { parseSnippetSegments } from "../lib/snippet.js";
import { trpc } from "../trpc.js";
import { HeaderSearch } from "./HeaderSearch.js";
import { ReviewQueuePill, useShellDrawer } from "./ReviewQueue.js";

/** Rows per `find` call — the server's default page. */
const PAGE_SIZE = 50;

type Facets = FindResult["facets"];

type SearchState =
  // `facets` carries the last answer's counts through a reload of the
  // list, so the filter column does not blink out on every toggle.
  | { kind: "loading"; facets: Facets | null }
  | { kind: "error"; message: string; facets: Facets | null }
  | {
      kind: "ready";
      key: string;
      rows: FoundRow[];
      total: number;
      facets: Facets;
      hasMore: boolean;
      nextOffset: number | null;
      loadingMore: boolean;
      moreError: string | null;
    };

function messageOf(err: unknown, fallback: string): string {
  // TRPCClientError#message is already the safe, hand-mapped message
  // server/errors.ts built — never a stack trace or connection string.
  return err instanceof Error ? err.message : fallback;
}

/** A link's click: a plain left click becomes an in-app push; anything else (middle, modified) is left to the browser. */
function pushOnPlainClick(route: Route) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(route, "push");
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function countLine(state: SearchState): string {
  switch (state.kind) {
    case "loading":
      return "Searching…";
    case "error":
      return "Search failed.";
    case "ready":
      if (state.total === 0) {
        return "Nothing matched.";
      }
      return state.rows.length < state.total ? `${plural(state.total, "result", "results")} · ${state.rows.length} shown` : plural(state.total, "result", "results");
  }
}

export function SearchView({ route }: { route: SearchRoute }) {
  // Pads itself clear of the review queue's drawer from `sm` up, as the feed does (ReviewQueue.tsx).
  const shellDrawerOpen = useShellDrawer().open;
  const [state, setState] = useState<SearchState>({ kind: "loading", facets: null });
  const key = formatRoute(route);

  // Keyed on the formatted address: the shell hands a fresh `route` object
  // on every re-read of `location`, and only a change of address is a new
  // search. `cancelled` drops an answer for an address since left.
  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ kind: "loading", facets: previous.facets }));
    trpc.find
      .query(findInputFor(route, 0, PAGE_SIZE))
      .then((page) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          key,
          rows: page.nodes,
          total: page.total,
          facets: page.facets,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          loadingMore: false,
          moreError: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((previous) => ({ kind: "error", message: messageOf(err, "Search failed unexpectedly."), facets: previous.facets }));
      });
    return () => {
      cancelled = true;
    };
    // `route` is read only through `key`, which is its whole content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** The next page, appended — kept only while the answer is still for this address and this offset. Rows already shown are not appended twice. */
  async function loadMore() {
    if (state.kind !== "ready" || state.loadingMore || state.nextOffset === null) {
      return;
    }
    const { key: pageKey, nextOffset: offset } = state;
    setState({ ...state, loadingMore: true, moreError: null });
    const isSamePage = (previous: SearchState): previous is Extract<SearchState, { kind: "ready" }> =>
      previous.kind === "ready" && previous.key === pageKey && previous.nextOffset === offset;
    try {
      const page = await trpc.find.query(findInputFor(route, offset, PAGE_SIZE));
      setState((previous) => {
        if (!isSamePage(previous)) return previous;
        const shown = new Set(previous.rows.map((row) => row.id));
        return {
          ...previous,
          rows: [...previous.rows, ...page.nodes.filter((row) => !shown.has(row.id))],
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          loadingMore: false,
        };
      });
    } catch (err) {
      const message = messageOf(err, "Failed to load more.");
      setState((previous) => (isSamePage(previous) ? { ...previous, loadingMore: false, moreError: message } : previous));
    }
  }

  const graphRoute = openInGraphRoute(route);

  return (
    // `body` is `overflow: hidden` (index.css, for the canvas), so this
    // element is the page's own scroll container.
    <main className={`h-dvh w-screen overflow-y-auto ${shellDrawerOpen ? "sm:pr-[492px]" : ""}`}>
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="mx-auto max-w-5xl px-4 py-6">
        <header className="glass mb-4 flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">Search</h1>
            <p className="mt-0.5 text-xs text-fg-muted" role="status">
              {countLine(state)}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <HeaderSearch key={route.q ?? ""} initialText={route.q ?? ""} onSubmit={(text) => navigate({ ...route, q: searchRouteFor(text).q }, "push")} />
            {graphRoute !== null && (
              <a
                href={formatRoute(graphRoute)}
                onClick={pushOnPlainClick(graphRoute)}
                className="shrink-0 rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
              >
                Open in graph
              </a>
            )}
            <ReviewQueuePill />
          </div>
        </header>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {state.facets !== null && <FacetColumn route={route} facets={state.facets} />}

          <section aria-label="Results" className="min-w-0 flex-1">
            {state.kind === "loading" && <p className="glass p-4 text-sm text-fg-muted">Loading…</p>}
            {state.kind === "error" && (
              <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {state.message}
              </p>
            )}
            {state.kind === "ready" && state.rows.length === 0 && (
              <p className="glass p-4 text-sm text-fg-muted">
                Nothing matched{route.types.length > 0 || route.projects.length > 0 || route.reviewsOnly ? ". Remove a filter to widen the search." : "."}
              </p>
            )}
            {state.kind === "ready" && state.rows.length > 0 && (
              <>
                <ol className="space-y-2">
                  {state.rows.map((row) => (
                    <ResultItem key={row.id} row={row} />
                  ))}
                </ol>
                {state.hasMore && state.nextOffset !== null && (
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={state.loadingMore}
                      className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
                    >
                      {state.loadingMore ? "Loading…" : "Load more"}
                    </button>
                    {state.moreError && (
                      <span role="alert" className="text-xs text-red-300">
                        {state.moreError}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/** The filter column: node types, projects, and reviews only, each option a toggle with the count it would give. Every change replaces the address. */
function FacetColumn({ route, facets }: { route: SearchRoute; facets: Facets }) {
  const typeOptions = facetOptions(facets.nodeTypes, route.types);
  const projectOptions = facetOptions(facets.projects, route.projects);

  return (
    <aside aria-label="Filters" className="glass shrink-0 space-y-4 p-3 sm:w-56">
      <FacetGroup label="Type" options={typeOptions} emptyText="No types" onToggle={(value) => navigate(toggleType(route, value), "replace")} />
      <FacetGroup label="Project" options={projectOptions} emptyText="No projects" onToggle={(value) => navigate(toggleProject(route, value), "replace")} />
      <div>
        <h2 className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Reviews</h2>
        <FacetButton label="Reviews only" count={facets.reviews} pressed={route.reviewsOnly} onClick={() => navigate(withReviewsOnly(route, !route.reviewsOnly), "replace")} />
      </div>
    </aside>
  );
}

function FacetGroup({ label, options, emptyText, onToggle }: { label: string; options: FacetOption[]; emptyText: string; onToggle: (value: string) => void }) {
  const headingId = `facet-${label.toLowerCase()}`;
  return (
    <div>
      <h2 id={headingId} className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {label}
      </h2>
      {options.length === 0 ? (
        <p className="text-xs text-fg-muted">{emptyText}</p>
      ) : (
        <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-1.5 sm:flex-col sm:items-stretch">
          {options.map((option) => (
            <FacetButton key={option.value} label={option.value} count={option.count} pressed={option.chosen} onClick={() => onToggle(option.value)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FacetButton({ label, count, pressed, onClick }: { label: string; count: number; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${
        pressed ? "border-accent bg-accent/20 text-fg" : "border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg"
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </button>
  );
}

function ResultItem({ row }: { row: FoundRow }) {
  const target = resultRoute(row);
  const status = rowStatus(row);
  return (
    <li data-node-id={row.id}>
      <a
        href={formatRoute(target)}
        onClick={pushOnPlainClick(target)}
        className="glass block rounded-2xl p-3 hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{row.title || "(untitled)"}</span>
          <span className="shrink-0 rounded-full border border-hairline bg-surface-strong px-2 py-0.5 text-[11px] text-fg-muted">{row.nodeType}</span>
          {row.isReview && <span className="shrink-0 rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-[11px] text-fg">review</span>}
        </span>
        {(row.project !== null || status !== null) && (
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
            {row.project !== null && (
              <span>
                project <span className="text-fg">{row.project}</span>
              </span>
            )}
            {status !== null && <span className="text-fg">{status}</span>}
          </span>
        )}
        {row.snippet !== null && <Snippet snippet={row.snippet} />}
      </a>
    </li>
  );
}

/** `ts_headline` output with its `[[ ]]` matches as `<mark>`, every character rendered as text. */
function Snippet({ snippet }: { snippet: string }) {
  return (
    <span className="mt-1.5 block text-xs leading-relaxed text-fg-muted">
      {parseSnippetSegments(snippet).map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="rounded bg-accent/25 px-0.5 text-fg">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}
