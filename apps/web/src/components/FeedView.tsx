// The feed view (node-views, design.md decision 6): a `view` node's
// filter drawn as a list. Mounted by the shell (App.tsx) under `/feed`,
// addressed by the view node's id (`?view=<id>`, lib/route.ts), and
// read-only — it never asks for a node's content and writes nothing.
//
// Two reads, in order. `getNodes` loads the view node itself: the address
// must name a canonical node of type `view` whose `metadata.filter` is an
// object — the server validated the contract at write time
// (packages/core/src/views.ts), so the guard (`viewFilterOf`, lib/
// viewFilter.ts, shared with the code view) is only against a hand-
// edited row, and anything else is the "not a view" empty state, never a
// redirect (node-views/spec.md, "The feed view is addressable"). Then
// `list` with that filter spread straight in plus a page size: a view's
// `filter` is exactly `list`'s input minus `limit`/`cursor` (design.md
// decision 1 — those belong to the reader), which is why no translation
// layer sits between the two. "Load more" is the same call with the
// previous response's `nextCursor`, appended in memory — the feed's page
// position is not in the URL, the way the graph's expansions are not
// (design.md Non-Goals).
//
// A row is title, type, the work-item fields when present, and every
// external link among its metadata values (lib/feedRow.ts, pure). The row
// itself is a button: activation pushes `{ view: "graph", node }` and the
// graph's own deep-link path draws the node on its own and selects it
// (GraphView.tsx's `applyRoute`); back returns here and this component
// re-fetches, since crossing views unmounts (design.md decision 4). Links
// sit beside the button, not inside it — an anchor inside a button is not
// valid HTML and would make a middle-click ambiguous.
//
// `/feed?view=abc`: the address parses (`viewId: "abc"`, route.ts leaves
// UUID validity to the server) and `getNodes` rejects the id with
// BAD_REQUEST — read here as "names no view", the same empty state a
// well-formed id that names nothing gets, because to the person the
// address is wrong in the same way. Every other failure is shown as the
// error it is.
//
// User copy never repeats a raw id (url-addressable-views review): it is
// in the address bar. The empty states keep the "Feed" heading and an
// `<a href="/graph">` to the graph so a bookmark to a dead view still
// reads as a page of this app with a way out.

import { TRPCClientError } from "@trpc/client";
import { useEffect, useState, type MouseEvent } from "react";
import { extractLinks, pickRowFields } from "../lib/feedRow.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { viewFilterOf, type ViewFilter, type ViewNode } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";
import { ReviewQueuePill } from "./ReviewQueue.js";

type ListResult = Awaited<ReturnType<typeof trpc.list.query>>;
type FeedRow = ListResult["nodes"][number];
type ListCursor = NonNullable<ListResult["nextCursor"]>;

/** Rows per `list` call — design.md decision 6. */
const PAGE_SIZE = 50;

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

type FeedState =
  | { kind: "no-view" }
  | { kind: "loading" }
  | { kind: "not-a-view" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      view: { id: string; title: string };
      filter: ViewFilter;
      rows: FeedRow[];
      hasMore: boolean;
      nextCursor: ListCursor | null;
      loadingMore: boolean;
      moreError: string | null;
    };

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "BAD_REQUEST";
}

function messageOf(err: unknown, fallback: string): string {
  // TRPCClientError#message is already the safe, hand-mapped message
  // server/errors.ts built — never a stack trace or connection string.
  return err instanceof Error ? err.message : fallback;
}

export function FeedView({ viewId }: { viewId: string | null }) {
  const [state, setState] = useState<FeedState>(viewId === null ? { kind: "no-view" } : { kind: "loading" });

  // Keyed on `viewId`: the shell re-renders this component with a new id
  // when the address changes view (same `key`, so no remount); the
  // `cancelled` flag drops a stale answer the way DetailPanel's own
  // getNodes effect does.
  useEffect(() => {
    if (viewId === null) {
      setState({ kind: "no-view" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    async function load(id: string) {
      let node: ViewNode | undefined;
      try {
        const lookup = await trpc.getNodes.query({ ids: [id] });
        node = lookup.nodes[0];
      } catch (err) {
        if (cancelled) return;
        setState(isBadRequest(err) ? { kind: "not-a-view" } : { kind: "error", message: messageOf(err, "Failed to load this view.") });
        return;
      }
      if (cancelled) return;
      const filter = node ? viewFilterOf(node) : null;
      if (!node || filter === null) {
        setState({ kind: "not-a-view" });
        return;
      }
      try {
        const page = await trpc.list.query({ ...filter, limit: PAGE_SIZE });
        if (cancelled) return;
        setState({
          kind: "ready",
          view: { id: node.id, title: node.title },
          filter,
          rows: page.nodes,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          loadingMore: false,
          moreError: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: "error", message: messageOf(err, "Failed to list this view's nodes.") });
      }
    }

    void load(viewId);
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  /**
   * The next page, appended. The updater checks that the page it is
   * appending is still the one asked for — the same view, the same
   * cursor — so an answer landing after the address changed view (a
   * whole new `ready` state, or a `loading` one) is dropped rather than
   * spliced into the wrong list.
   */
  async function loadMore() {
    if (state.kind !== "ready" || state.loadingMore || state.nextCursor === null) {
      return;
    }
    const { filter, nextCursor: cursor, view } = state;
    setState({ ...state, loadingMore: true, moreError: null });
    try {
      const page = await trpc.list.query({ ...filter, limit: PAGE_SIZE, cursor });
      setState((previous) =>
        previous.kind === "ready" && previous.view.id === view.id && previous.nextCursor === cursor
          ? { ...previous, rows: [...previous.rows, ...page.nodes], hasMore: page.hasMore, nextCursor: page.nextCursor, loadingMore: false }
          : previous,
      );
    } catch (err) {
      const message = messageOf(err, "Failed to load more.");
      setState((previous) =>
        previous.kind === "ready" && previous.view.id === view.id && previous.nextCursor === cursor ? { ...previous, loadingMore: false, moreError: message } : previous,
      );
    }
  }

  /** Row activation (node-views/spec.md, "Activating a row"): a push, so the browser's back control returns to this feed. */
  function activate(row: FeedRow) {
    navigate({ view: "graph", q: null, types: [], node: row.id }, "push");
  }

  // A real `href` so the link is a link (middle-click, copy address); a
  // plain left click goes through `navigate` so the shell swaps views
  // without a page load, the way every in-app move does.
  function handleOpenGraph(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(GRAPH_HOME, "push");
  }

  const heading = state.kind === "ready" ? state.view.title || "(untitled view)" : "Feed";

  return (
    // `body` is `overflow: hidden` (index.css, for the canvas), so this
    // element is the page's own scroll container.
    <main className="h-dvh w-screen overflow-y-auto">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <header className="glass mb-4 flex flex-wrap items-start justify-between gap-4 p-4 sm:flex-nowrap">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{heading}</h1>
            {state.kind === "ready" && (
              <p className="mt-0.5 text-xs text-fg-muted" role="status">
                {state.rows.length === 0 ? "No nodes match this view." : `${state.rows.length} shown${state.hasMore ? " · more match this view" : ""}`}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
            <a
              href={formatRoute(GRAPH_HOME)}
              onClick={handleOpenGraph}
              className="shrink-0 rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
            >
              Open the graph
            </a>
            <ReviewQueuePill />
          </div>
        </header>

        {state.kind === "no-view" && <p className="glass p-4 text-sm text-fg-muted">No view is named in the address.</p>}
        {state.kind === "not-a-view" && <p className="glass p-4 text-sm text-fg-muted">The address does not name a view.</p>}
        {state.kind === "loading" && <p className="glass p-4 text-sm text-fg-muted">Loading…</p>}
        {state.kind === "error" && (
          <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {state.message}
          </p>
        )}

        {state.kind === "ready" && state.rows.length === 0 && <p className="glass p-4 text-sm text-fg-muted">No nodes match this view.</p>}

        {state.kind === "ready" && state.rows.length > 0 && (
          <>
            <ul aria-label="Feed rows" className="space-y-2">
              {state.rows.map((row) => (
                <FeedRowItem key={row.id} row={row} onActivate={activate} />
              ))}
            </ul>
            {state.hasMore && (
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
      </div>
    </main>
  );
}

function FeedRowItem({ row, onActivate }: { row: FeedRow; onActivate: (row: FeedRow) => void }) {
  const fields = pickRowFields(row.metadata);
  const links = extractLinks(row.metadata);
  const hasFields = fields.status !== null || fields.priority !== null || fields.assignee !== null;

  return (
    <li data-node-id={row.id} className="glass flex items-start justify-between gap-3 p-3">
      <button
        type="button"
        onClick={() => onActivate(row)}
        aria-label={`Open ${row.title || "(untitled)"} in the graph`}
        className="min-w-0 flex-1 rounded text-left focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{row.title || "(untitled)"}</span>
          <span className="shrink-0 rounded-full border border-hairline bg-surface-strong px-2 py-0.5 text-[11px] text-fg-muted">{row.nodeType}</span>
        </span>
        {hasFields && (
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-muted">
            {fields.status !== null && (
              <span>
                status <span className="text-fg">{fields.status}</span>
              </span>
            )}
            {fields.priority !== null && (
              <span>
                priority <span className="text-fg">{fields.priority}</span>
              </span>
            )}
            {fields.assignee !== null && (
              <span>
                assignee <span className="text-fg">{fields.assignee}</span>
              </span>
            )}
          </span>
        )}
      </button>
      {links.length > 0 && (
        <span className="flex shrink-0 flex-wrap justify-end gap-2 text-xs">
          {links.map((link) => (
            <a key={link.key} href={link.href} target="_blank" rel="noopener noreferrer" className="rounded text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
              {link.key}
            </a>
          ))}
        </span>
      )}
    </li>
  );
}
