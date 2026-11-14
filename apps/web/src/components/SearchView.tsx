// The search results view (search-results-view, design.md decisions 6 and
// 7): one address-held list of nodes, narrowed by node type, project, and
// reviews only. Mounted lazily by the shell (App.tsx) under `/search`; the
// text and filters live in the address (lib/route.ts), so a reload, a
// shared link, and back/forward all show the same results. Read-only.
//
// One `find` call per page answers both the rows and the facet counts.
// The first page is fetched whenever the route changes (keyed on its
// formatted address, the same string `navigate` compares) or "Try again"
// is pressed; "Load more" asks for the next page at the server's
// `nextOffset` — never offset plus limit, since the server's response
// budget can drop rows from the tail — and drops the answer if the route
// moved on meanwhile (FeedView's guard). Facets stay those of the first
// page: they count every match, not the page. Past the server's offset
// bound the answer is `capped`, and the view says to narrow instead of
// offering more.
//
// While a new address loads, the previous answer stays on screen, dimmed,
// so a filter toggle never blanks the page. The last few answers are kept
// in a module-level cache with their scroll position, so coming back to a
// results address (back/forward from a result) renders at once and then
// revalidates in the background.
//
// Filters `replace` the address and a text submit `push`es one
// (search-results/spec.md, "Results are held in the address"). A result
// is a real link (`href` from lib/searchRow.ts's `resultRoute`) so it can
// be middle-clicked or copied; a plain click goes through `navigate`. A
// snippet's `[[ ]]` highlights are split by `parseSnippetSegments` and
// rendered as JSX text, never markup (lib/snippet.ts on why).

import { TRPCClientError } from "@trpc/client";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BoundedCache } from "../lib/boundedCache.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type SearchRoute } from "../lib/route.js";
import {
  approximateSearchRoute,
  facetOptions,
  findInputFor,
  isNoSearchableTermsMessage,
  openInGraphLink,
  resultRoute,
  rowStatus,
  searchRouteFor,
  toggleProject,
  toggleType,
  visibleFacetOptions,
  withReviewsOnly,
  type FacetOption,
  type FindResult,
  type FoundRow,
} from "../lib/searchRow.js";
import { parseSnippetSegments } from "../lib/snippet.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { trpc } from "../trpc.js";
import { HeaderSearch } from "./HeaderSearch.js";
import { ReviewQueuePill, useShellDrawer } from "./ReviewQueue.js";

/** Rows per `find` call — the server's default page. */
const PAGE_SIZE = 50;
/** The most rows one `find` call returns (MAX_FIND_LIMIT in packages/core/src/find.ts) — the largest page a revalidation can re-fetch. */
const MAX_PAGE_SIZE = 200;
/** Results addresses whose last answer is kept for back/forward. */
const CACHED_ADDRESSES = 5;

type Facets = FindResult["facets"];

const NO_FACETS: Facets = { nodeTypes: [], projects: [], reviews: 0 };

/** One landed answer for one address, every loaded page appended. */
interface Snapshot {
  key: string;
  rows: FoundRow[];
  total: number;
  facets: Facets;
  hasMore: boolean;
  nextOffset: number | null;
  capped: boolean;
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string } | { kind: "no-terms" };

interface SearchState {
  phase: Phase;
  /** The last answer that landed — possibly for the previous address, shown dimmed while this one loads. */
  shown: Snapshot | null;
  loadingMore: boolean;
  moreError: string | null;
}

const answers = new BoundedCache<{ snapshot: Snapshot; scrollTop: number }>(CACHED_ADDRESSES);

function snapshotOf(key: string, page: FindResult): Snapshot {
  return { key, rows: page.nodes, total: page.total, facets: page.facets, hasMore: page.hasMore, nextOffset: page.nextOffset, capped: page.capped };
}

function messageOf(err: unknown, fallback: string): string {
  // TRPCClientError#message is already the safe, hand-mapped message
  // server/errors.ts built — never a stack trace or connection string.
  return err instanceof Error ? err.message : fallback;
}

function isNoTermsError(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "BAD_REQUEST" && isNoSearchableTermsMessage(err.message);
}

/** A link's click: a plain left click becomes an in-app push; anything else (middle, modified) is left to the browser. */
function pushOnPlainClick(route: Parameters<typeof navigate>[0]) {
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

function countLine(phase: Phase, current: Snapshot | null): string {
  if (phase.kind === "loading") return "Searching…";
  if (phase.kind === "error" && current === null) return "Search failed.";
  if (phase.kind === "no-terms" || current === null || current.total === 0) return "0 results";
  const total = plural(current.total, "result", "results");
  if (current.rows.length >= current.total) return total;
  return current.capped ? `${total} · first ${current.rows.length} shown` : `${total} · ${current.rows.length} shown`;
}

export function SearchView({ route }: { route: SearchRoute }) {
  // Pads itself clear of the review queue's drawer from `sm` up, as the feed does (ReviewQueue.tsx).
  const shellDrawerOpen = useShellDrawer().open;
  const wide = useMediaQuery("(min-width: 640px)");
  const [state, setState] = useState<SearchState>({ phase: { kind: "loading" }, shown: null, loadingMore: false, moreError: null });
  const [retry, setRetry] = useState(0);
  const key = formatRoute(route);

  const mainRef = useRef<HTMLElement>(null);
  const scrollTopRef = useRef(0);
  const pendingScroll = useRef<{ key: string; top: number } | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Keyed on the formatted address: the shell hands a fresh `route` object
  // on every re-read of `location`, and only a change of address is a new
  // search. `cancelled` drops an answer for an address since left. The
  // cleanup files this address's answer and scroll position in the cache.
  useEffect(() => {
    let cancelled = false;
    const cached = answers.get(key);
    // Rows past one call's maximum cannot be re-fetched in one call; then only the counts are refreshed.
    const refreshRows = cached === undefined || cached.snapshot.rows.length <= MAX_PAGE_SIZE;
    const limit = cached !== undefined && refreshRows ? Math.max(cached.snapshot.rows.length, PAGE_SIZE) : PAGE_SIZE;
    if (cached !== undefined) {
      pendingScroll.current = { key, top: cached.scrollTop };
      setState({ phase: { kind: "ready" }, shown: cached.snapshot, loadingMore: false, moreError: null });
    } else {
      pendingScroll.current = { key, top: 0 };
      setState((previous) => ({ ...previous, phase: { kind: "loading" }, loadingMore: false, moreError: null }));
    }

    trpc.find
      .query(findInputFor(route, 0, limit))
      .then((page) => {
        if (cancelled) return;
        setState((previous) => {
          const fresh = snapshotOf(key, page);
          const shown = !refreshRows && previous.shown?.key === key ? { ...previous.shown, total: fresh.total, facets: fresh.facets } : fresh;
          return { phase: { kind: "ready" }, shown, loadingMore: false, moreError: null };
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const phase: Phase = isNoTermsError(err) ? { kind: "no-terms" } : { kind: "error", message: messageOf(err, "Search failed unexpectedly.") };
        setState((previous) => ({ ...previous, phase }));
      });

    return () => {
      cancelled = true;
      const shown = stateRef.current.shown;
      if (shown !== null && shown.key === key) {
        answers.set(key, { snapshot: shown, scrollTop: scrollTopRef.current });
      }
    };
    // `route` is read only through `key`, which is its whole content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  // A cached answer returns to where it was scrolled; a fresh one starts at the top once it lands.
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (pending !== null && state.shown?.key === pending.key && mainRef.current) {
      mainRef.current.scrollTop = pending.top;
      scrollTopRef.current = pending.top;
      pendingScroll.current = null;
    }
  }, [state.shown]);

  /** The next page, appended — kept only while the answer is still for this address and this offset. Rows already shown are not appended twice. */
  async function loadMore() {
    const shown = state.shown;
    if (state.phase.kind !== "ready" || state.loadingMore || shown === null || shown.key !== key || shown.nextOffset === null) {
      return;
    }
    const offset = shown.nextOffset;
    setState({ ...state, loadingMore: true, moreError: null });
    const isSamePage = (previous: SearchState): boolean => previous.shown?.key === key && previous.shown.nextOffset === offset;
    try {
      const page = await trpc.find.query(findInputFor(route, offset, PAGE_SIZE));
      setState((previous) => {
        if (!isSamePage(previous) || previous.shown === null) return previous;
        const seen = new Set(previous.shown.rows.map((row) => row.id));
        return {
          ...previous,
          shown: {
            ...previous.shown,
            rows: [...previous.shown.rows, ...page.nodes.filter((row) => !seen.has(row.id))],
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
            capped: page.capped,
          },
          loadingMore: false,
        };
      });
    } catch (err) {
      const message = messageOf(err, "Failed to load more.");
      setState((previous) => (isSamePage(previous) ? { ...previous, loadingMore: false, moreError: message } : previous));
    }
  }

  const { phase } = state;
  const current = state.shown !== null && state.shown.key === key ? state.shown : null;
  const graphLink = openInGraphLink(route);
  const approximate = approximateSearchRoute(route);
  const hasFilters = route.types.length > 0 || route.projects.length > 0 || route.reviewsOnly;
  const failed = phase.kind === "error" || phase.kind === "no-terms";
  // The counts beside the filters: this answer's; while loading, the last
  // one's; after a failure with none, the chosen filters at 0 so each can
  // still be removed.
  const facets = phase.kind === "ready" && current !== null ? current.facets : (state.shown?.facets ?? (failed ? NO_FACETS : null));
  const facetsBusy = phase.kind !== "ready";
  // Rows: this address's once landed; while loading, the last answer's, dimmed.
  const rows = phase.kind === "loading" ? state.shown : phase.kind === "no-terms" ? null : current;
  const rowsDimmed = phase.kind === "loading" && rows !== null;
  const heading = route.q === null ? "All nodes" : `Results for "${route.q}"`;

  const filterColumn =
    facets === null ? null : wide ? (
      <FacetColumn route={route} facets={facets} busy={facetsBusy} framed />
    ) : (
      <FiltersDisclosure chosen={route.types.length + route.projects.length + (route.reviewsOnly ? 1 : 0)}>
        <FacetColumn route={route} facets={facets} busy={facetsBusy} />
      </FiltersDisclosure>
    );

  return (
    // `body` is `overflow: hidden` (index.css, for the canvas), so this
    // element is the page's own scroll container.
    <main
      ref={mainRef}
      onScroll={(e) => {
        scrollTopRef.current = e.currentTarget.scrollTop;
      }}
      className={`h-dvh w-screen overflow-y-auto ${shellDrawerOpen ? "sm:pr-[492px]" : ""}`}
    >
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="mx-auto max-w-5xl px-4 py-6">
        <header className="glass mb-4 flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{heading}</h1>
            <p className="mt-0.5 text-xs text-fg-muted" role="status">
              {countLine(phase, current)}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
            <HeaderSearch initialText={route.q ?? ""} onSubmit={(text) => navigate({ ...route, q: searchRouteFor(text).q }, "push")} />
            <a
              href={formatRoute(graphLink.route)}
              onClick={pushOnPlainClick(graphLink.route)}
              className="rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {graphLink.label}
            </a>
            <ReviewQueuePill />
          </div>
        </header>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {filterColumn}

          <section aria-label="Results" className="min-w-0 flex-1 space-y-3">
            {phase.kind === "error" && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <span className="min-w-0">{phase.message}</span>
                <button
                  type="button"
                  onClick={() => setRetry((n) => n + 1)}
                  className="min-h-11 shrink-0 rounded-lg border border-red-500/40 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0"
                >
                  Try again
                </button>
              </div>
            )}
            {phase.kind === "no-terms" && <p className="glass p-4 text-sm text-fg-muted">Add a word that isn't a common stopword.</p>}
            {phase.kind === "loading" && rows === null && <p className="glass p-4 text-sm text-fg-muted">Loading…</p>}

            {phase.kind === "ready" && current !== null && current.rows.length === 0 && (
              <div className="glass space-y-2 p-4 text-sm text-fg-muted">
                <p>Nothing matched{hasFilters ? ". Remove a filter to widen the search." : "."}</p>
                {approximate !== null && (
                  <p>
                    <a
                      href={formatRoute(approximate)}
                      onClick={pushOnPlainClick(approximate)}
                      className="rounded text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      Try the graph's approximate search →
                    </a>
                  </p>
                )}
              </div>
            )}

            {rows !== null && rows.rows.length > 0 && (
              <>
                <ol aria-busy={rowsDimmed} className={`space-y-2 ${rowsDimmed ? "opacity-60" : ""}`}>
                  {rows.rows.map((row) => (
                    <ResultItem key={row.id} row={row} />
                  ))}
                </ol>
                {phase.kind === "ready" && current !== null && current.capped && (
                  <p className="text-xs text-fg-muted">Showing the first {current.rows.length} — narrow the filters to see more.</p>
                )}
                {phase.kind === "ready" && current !== null && current.hasMore && current.nextOffset !== null && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={state.loadingMore}
                      className="min-h-11 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:min-h-0"
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

/** Below `sm`, the filters fold behind a disclosure — open at first only when nothing is chosen, then wherever the person leaves it. */
function FiltersDisclosure({ chosen, children }: { chosen: number; children: ReactNode }) {
  const [initiallyOpen] = useState(chosen === 0);
  return (
    <details open={initiallyOpen} className="glass p-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-fg focus:outline-none focus:ring-2 focus:ring-accent">
        Filters ({chosen} chosen)
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** The filter column: reviews only, projects, and node types, each option a toggle with the count it would give. Every change replaces the address. */
function FacetColumn({ route, facets, busy, framed = false }: { route: SearchRoute; facets: Facets; busy: boolean; framed?: boolean }) {
  return (
    <aside aria-label="Filters" aria-busy={busy} className={`shrink-0 space-y-4 ${framed ? "glass w-56 p-3" : ""}`}>
      <div>
        <h2 className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Reviews</h2>
        <FacetButton label="Reviews only" count={facets.reviews} pressed={route.reviewsOnly} busy={busy} onClick={() => navigate(withReviewsOnly(route, !route.reviewsOnly), "replace")} />
      </div>
      <FacetGroup label="Project" options={facetOptions(facets.projects, route.projects)} emptyText="No projects" busy={busy} onToggle={(value) => navigate(toggleProject(route, value), "replace")} />
      <FacetGroup label="Type" options={facetOptions(facets.nodeTypes, route.types)} emptyText="No types" busy={busy} onToggle={(value) => navigate(toggleType(route, value), "replace")} />
    </aside>
  );
}

function FacetGroup({ label, options, emptyText, busy, onToggle }: { label: string; options: FacetOption[]; emptyText: string; busy: boolean; onToggle: (value: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const headingId = `facet-${label.toLowerCase()}`;
  const visible = visibleFacetOptions(options, showAll);
  return (
    <div>
      <h2 id={headingId} className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {label}
      </h2>
      {options.length === 0 ? (
        <p className="text-xs text-fg-muted">{emptyText}</p>
      ) : (
        <>
          <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-1.5 sm:flex-col sm:items-stretch">
            {visible.map((option) => (
              <FacetButton key={option.value} label={option.value} count={option.count} pressed={option.chosen} busy={busy} onClick={() => onToggle(option.value)} />
            ))}
          </div>
          {(showAll || visible.length < options.length) && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((on) => !on)}
              className="mt-1.5 min-h-11 rounded text-xs text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0"
            >
              {showAll ? "Show fewer" : `Show all (${options.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function FacetButton({ label, count, pressed, busy, onClick }: { label: string; count: number; pressed: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${label}, ${count} results`}
      title={label}
      onClick={onClick}
      className={`flex min-h-11 items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${
        pressed ? "border-accent bg-accent/20 text-fg" : "border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg"
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className={`shrink-0 tabular-nums ${busy ? "opacity-60" : ""}`}>{count}</span>
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
