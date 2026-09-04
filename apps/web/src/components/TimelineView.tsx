// The timeline view (timeline-view, design.md decision 5): for one anchor
// node, the items connected to it that carry an event time, newest first,
// narrowed to the node types the reader chooses out of the ones the
// `view` node names. Mounted by the shell (App.tsx) under `/timeline`,
// addressed by `?view=<id>&node=<anchor>&type=<t>&type=<t>` (lib/
// route.ts), and read-only: it never asks for a node's content and
// writes nothing.
//
// Reads. The view loads exactly as the feed does: `getNodes` for the view
// node, `viewFilterOf` (lib/viewFilter.ts, shared) for its filter — the
// renderer is not checked, so `/timeline` draws any view's filter as
// chips. Then, with an anchor, `getNodes([node])` for the heading runs
// beside `timeline({ anchorId, nodeTypes, sourceSystems, limit })`: the
// chosen types (`chosenTypes`, lib/timelineRow.ts — the address's `type`s
// intersected with the view's `nodeTypes`, every chip when the address
// names none, `nodeTypes` omitted when the view names none) and the
// view's source systems spread in exactly as the feed spreads its filter
// into `list`. The list is keyed on `(viewId, node, chosen)`: a chip
// toggle re-reads, a stale answer is dropped by the effect's `cancelled`
// flag (the feed's pattern), and a `ready` state loaded for another
// address is never read from — `forViewId` on the view state, the code
// view's guard, keeps the list effect from issuing the old view's read
// under the new address in the flush where both effects run. Every chip
// deselected is no read at all and the "no type is chosen" state.
//
// "Load more" is the feed's: the previous answer's `nextCursor`, appended
// only while the view, anchor, and chosen set are unchanged — which is
// what enforces core's rule that a `TimelineCursor` is never replayed
// across anchors or narrowings (packages/core/src/timeline.ts).
//
// Navigation. A chip toggle formats the new route and `navigate`s with
// "replace" (design.md decision 4: a chip is a state of one listing, so
// back leaves the view rather than undoing a toggle); the shell re-reads
// the address and re-renders this component with new `types`. Row
// activation pushes `{ view: "graph", node }` and "Open in graph" pushes
// the anchor, so back returns here with the chips as the address kept
// them. Links sit beside the row's button, not inside it — an anchor
// inside a button is not valid HTML.
//
// The empty states — no view, not a view, no anchor, anchor not found,
// nothing timed, no type chosen — each keep the "Timeline" heading, the
// address, and a way to the graph (timeline-view/spec.md, "The timeline
// view is addressable": none "SHALL redirect or change the address").
// `/timeline?view=abc` parses and `getNodes` rejects the id with
// BAD_REQUEST, read as "names no view" the way the feed reads it; an
// anchor `getNodes` answers nothing for, or that `timeline` reports
// NOT_FOUND, is "not found". User copy never repeats a raw id: it is in
// the address bar.

import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { extractLinks, pickRowFields } from "../lib/feedRow.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { addressTypesFor, chosenTypes, formatEventTime, relationLabel, toggleType, type TypeSelection } from "../lib/timelineRow.js";
import { viewFilterOf, type ViewFilter, type ViewNode } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";

type TimelineResult = Awaited<ReturnType<typeof trpc.timeline.query>>;
type TimelineRow = TimelineResult["rows"][number];
type TimelineCursor = NonNullable<TimelineResult["nextCursor"]>;

/** Rows per `timeline` call — core's `DEFAULT_TIMELINE_LIMIT`, the feed's page size. */
const PAGE_SIZE = 50;

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

export interface TimelineViewProps {
  viewId: string | null;
  node: string | null;
  types: string[];
}

interface ViewInfo {
  id: string;
  title: string;
}

/** `forViewId` is the address the ready state was loaded for: a render can still hold the previous view's state after `viewId` changed, and the list effect must wait for the reload. */
type ViewState =
  | { kind: "no-view" }
  | { kind: "loading" }
  | { kind: "not-a-view" }
  | { kind: "error"; message: string }
  | { kind: "ready"; forViewId: string; view: ViewInfo; filter: ViewFilter };

/**
 * The anchor and its page. `key` is the `(viewId, node, chosen)` the state
 * was loaded for, compared by the load-more guard. `none-chosen` still
 * carries the anchor, read for the heading, but issued no `timeline`.
 */
type ListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "anchor-missing" }
  | { kind: "error"; message: string }
  | { kind: "none-chosen"; anchor: ViewInfo }
  | {
      kind: "ready";
      key: string;
      anchor: ViewInfo;
      rows: TimelineRow[];
      hasMore: boolean;
      nextCursor: TimelineCursor | null;
      untimedCount: number;
      loadingMore: boolean;
      moreError: string | null;
    };

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "BAD_REQUEST";
}

function isNotFound(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "NOT_FOUND";
}

function messageOf(err: unknown, fallback: string): string {
  // TRPCClientError#message is already the safe, hand-mapped message
  // server/errors.ts built — never a stack trace or connection string.
  return err instanceof Error ? err.message : fallback;
}

/** The `(viewId, node, chosen)` a list is loaded for, as one comparable string — newlines as separators, which no id or node type carries. */
function listKeyOf(viewId: string, node: string, selection: TypeSelection): string {
  const chosen = selection.chosen === null ? "*" : selection.chosen.join("\n");
  return `${viewId}\n${node}\n\n${chosen}`;
}

export function TimelineView({ viewId, node, types }: TimelineViewProps) {
  const [view, setView] = useState<ViewState>(viewId === null ? { kind: "no-view" } : { kind: "loading" });
  const [list, setList] = useState<ListState>({ kind: "idle" });

  // The view, keyed on `viewId`: the shell re-renders this component with
  // a new id when the address changes view (same `key`, so no remount);
  // the `cancelled` flag drops a stale answer the way FeedView's effect
  // does.
  useEffect(() => {
    if (viewId === null) {
      setView({ kind: "no-view" });
      return;
    }
    let cancelled = false;
    setView({ kind: "loading" });

    async function load(id: string) {
      let viewNode: ViewNode | undefined;
      try {
        const lookup = await trpc.getNodes.query({ ids: [id] });
        viewNode = lookup.nodes[0];
      } catch (err) {
        if (cancelled) return;
        setView(isBadRequest(err) ? { kind: "not-a-view" } : { kind: "error", message: messageOf(err, "Failed to load this view.") });
        return;
      }
      if (cancelled) return;
      const filter = viewNode ? viewFilterOf(viewNode) : null;
      if (!viewNode || filter === null) {
        setView({ kind: "not-a-view" });
        return;
      }
      setView({ kind: "ready", forViewId: id, view: { id: viewNode.id, title: viewNode.title }, filter });
    }

    void load(viewId);
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  // What the address chooses out of what the view names — pure (lib/
  // timelineRow.ts), `null` until the view for this address is loaded.
  // Memoized on the address's types as text, not the array: the shell
  // hands this component a fresh `types` array on every navigation, and
  // a popstate to the same address must not read the page again.
  const typesKey = types.join("\n");
  const selection = useMemo<TypeSelection | null>(
    () => (view.kind === "ready" && view.forViewId === viewId ? chosenTypes(typesKey.length === 0 ? [] : typesKey.split("\n"), view.filter.nodeTypes ?? null) : null),
    [view, viewId, typesKey],
  );
  const sourceSystems = view.kind === "ready" ? view.filter.sourceSystems : undefined;
  const listKey = selection !== null && viewId !== null && node !== null ? listKeyOf(viewId, node, selection) : null;

  // The anchor and its page, keyed on `(viewId, node, chosen)`: `selection`
  // changes identity only when the loaded view or the address's types do,
  // and `sourceSystems` only with the loaded view. `getNodes([node])` for
  // the heading runs beside `timeline`; with every chip deselected only
  // the anchor is read.
  useEffect(() => {
    if (selection === null || viewId === null || node === null) {
      setList({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setList({ kind: "loading" });
    const key = listKeyOf(viewId, node, selection);
    const chosen = selection.chosen;

    async function load(anchorId: string) {
      const anchorRead = trpc.getNodes.query({ ids: [anchorId] });
      const pageRead = selection?.none ? null : trpc.timeline.query({ anchorId, nodeTypes: chosen ?? undefined, sourceSystems: sourceSystems ?? undefined, limit: PAGE_SIZE });
      const [anchorSettled, pageSettled] = await Promise.allSettled([anchorRead, pageRead ?? Promise.resolve(null)]);
      if (cancelled) return;

      if (anchorSettled.status === "rejected") {
        const err = anchorSettled.reason;
        setList(isBadRequest(err) ? { kind: "anchor-missing" } : { kind: "error", message: messageOf(err, "Failed to load this node.") });
        return;
      }
      const anchorNode = anchorSettled.value.nodes[0];
      if (anchorNode === undefined) {
        setList({ kind: "anchor-missing" });
        return;
      }
      const anchor: ViewInfo = { id: anchorNode.id, title: anchorNode.title };

      if (pageSettled.status === "rejected") {
        const err = pageSettled.reason;
        setList(isNotFound(err) || isBadRequest(err) ? { kind: "anchor-missing" } : { kind: "error", message: messageOf(err, "Failed to load this timeline.") });
        return;
      }
      const page = pageSettled.value;
      if (page === null) {
        setList({ kind: "none-chosen", anchor });
        return;
      }
      setList({
        kind: "ready",
        key,
        anchor,
        rows: page.rows,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        untimedCount: page.untimedCount,
        loadingMore: false,
        moreError: null,
      });
    }

    void load(node);
    return () => {
      cancelled = true;
    };
  }, [selection, sourceSystems, viewId, node]);

  /**
   * The next page, appended. The updater checks that the page it is
   * appending is still the one asked for — the same `(viewId, node,
   * chosen)` key, the same cursor — so an answer landing after the
   * address changed (a whole new `ready` state, or a `loading` one) is
   * dropped rather than spliced into the wrong list. This is what keeps a
   * cursor minted under one anchor or narrowing from being replayed under
   * another.
   */
  async function loadMore() {
    if (list.kind !== "ready" || list.loadingMore || list.nextCursor === null || node === null || selection === null || list.key !== listKey) {
      return;
    }
    const { key, nextCursor: cursor } = list;
    setList({ ...list, loadingMore: true, moreError: null });
    try {
      const page = await trpc.timeline.query({ anchorId: node, nodeTypes: selection.chosen ?? undefined, sourceSystems: sourceSystems ?? undefined, limit: PAGE_SIZE, cursor });
      setList((previous) =>
        previous.kind === "ready" && previous.key === key && previous.nextCursor === cursor
          ? { ...previous, rows: [...previous.rows, ...page.rows], hasMore: page.hasMore, nextCursor: page.nextCursor, untimedCount: page.untimedCount, loadingMore: false }
          : previous,
      );
    } catch (err) {
      const message = messageOf(err, "Failed to load more.");
      setList((previous) => (previous.kind === "ready" && previous.key === key && previous.nextCursor === cursor ? { ...previous, loadingMore: false, moreError: message } : previous));
    }
  }

  /** A chip toggle (timeline-view/spec.md, "Deselecting a type"): the address rewritten in place, never a history entry. */
  function toggleChip(type: string) {
    if (selection === null || selection.chosen === null) {
      return;
    }
    navigate({ view: "timeline", viewId, node, types: addressTypesFor(toggleType(selection.chosen, type)) }, "replace");
  }

  /** Row activation (timeline-view/spec.md, "Activating a row"): a push, so the browser's back control returns to this timeline. */
  function activate(row: TimelineRow) {
    navigate({ view: "graph", q: null, types: [], node: row.id }, "push");
  }

  // A real `href` so the link is a link (middle-click, copy address); a
  // plain left click goes through `navigate` so the shell swaps views
  // without a page load, the way every in-app move does.
  function handleGraphLink(route: GraphRoute) {
    return (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(route, "push");
    };
  }

  const viewTitle = view.kind === "ready" ? view.view.title || "(untitled view)" : null;
  const anchor = list.kind === "ready" || list.kind === "none-chosen" ? list.anchor : null;
  // The graph link names the anchor once it is known; before that, or in
  // an empty state, it is the bare graph.
  const graphRoute: GraphRoute = anchor !== null ? { view: "graph", q: null, types: [], node: anchor.id } : GRAPH_HOME;
  const heading = anchor !== null && viewTitle !== null ? `${anchor.title || "(untitled)"} · ${viewTitle}` : "Timeline";

  // One line under the heading: the count while a page is shown, the view's
  // name while a view is loaded but no page is (so the "choose a node"
  // state names the view, as the spec asks).
  let status: string | null = null;
  if (list.kind === "ready") {
    status = list.rows.length === 0 ? "No connected items carry a time." : `${list.rows.length} shown${list.hasMore ? " · more exist" : ""}`;
  } else if (viewTitle !== null && node === null) {
    status = viewTitle;
  }

  // The chip bar: drawn whenever the view names types and an anchor is
  // addressed, in every list state — the chips are the address's, not
  // the page's, so they stay while a page loads or when nothing is chosen.
  const chips = selection?.chips ?? null;
  const showChips = chips !== null && node !== null && list.kind !== "anchor-missing";

  // The body's one paragraph of copy, by state; `null` while rows draw.
  let copy: string | null = null;
  if (view.kind === "no-view") {
    copy = "No view is named in the address.";
  } else if (view.kind === "not-a-view") {
    copy = "The address does not name a view.";
  } else if (view.kind === "loading" || (view.kind === "ready" && view.forViewId !== viewId)) {
    copy = "Loading…";
  } else if (view.kind === "ready" && node === null) {
    copy = "Choose a node in the graph to see its timeline.";
  } else if (list.kind === "loading" || list.kind === "idle") {
    copy = "Loading…";
  } else if (list.kind === "anchor-missing") {
    copy = "That node was not found.";
  } else if (list.kind === "none-chosen") {
    copy = "No type is chosen.";
  } else if (list.kind === "ready" && list.rows.length === 0) {
    // The note below carries the count when there is one; without one the
    // selection (types and source systems) matched nothing at all.
    copy = list.untimedCount > 0 ? "Nothing connected to this node carries a time." : "Nothing matching the selection is connected to this node.";
  }
  const errorMessage = view.kind === "error" ? view.message : list.kind === "error" ? list.message : null;

  return (
    // `body` is `overflow: hidden` (index.css, for the canvas), so this
    // element is the page's own scroll container.
    <main className="h-dvh w-screen overflow-y-auto">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <header className="glass mb-4 flex items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{heading}</h1>
            {status !== null && (
              <p className="mt-0.5 text-xs text-fg-muted" role="status">
                {status}
              </p>
            )}
          </div>
          <a href={formatRoute(graphRoute)} onClick={handleGraphLink(graphRoute)} className="shrink-0 rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
            {graphRoute.node === null ? "Open the graph" : "Open in graph"}
          </a>
        </header>

        {showChips && (
          <div role="group" aria-label="Types" className="mb-4 flex flex-wrap gap-2">
            {chips.map((type) => {
              const pressed = selection?.chosen?.includes(type) ?? false;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => toggleChip(type)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent ${
                    pressed ? "border-accent/60 bg-accent/20 text-fg" : "border-hairline bg-surface text-fg-muted hover:text-fg"
                  }`}
                >
                  {type}
                </button>
              );
            })}
          </div>
        )}

        {errorMessage !== null && (
          <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </p>
        )}
        {errorMessage === null && copy !== null && <p className="glass p-4 text-sm text-fg-muted">{copy}</p>}

        {list.kind === "ready" && list.rows.length > 0 && (
          <ol aria-label="Timeline rows" className="space-y-2">
            {list.rows.map((row) => (
              <TimelineRowItem key={row.id} row={row} onActivate={activate} />
            ))}
          </ol>
        )}

        {list.kind === "ready" && list.untimedCount > 0 && (
          <p role="note" className="mt-3 text-xs text-fg-muted">
            {list.untimedCount} connected {list.untimedCount === 1 ? "item has" : "items have"} no time.
          </p>
        )}

        {list.kind === "ready" && list.hasMore && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={list.loadingMore}
              className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            >
              {list.loadingMore ? "Loading…" : "Load more"}
            </button>
            {list.moreError && (
              <span role="alert" className="text-xs text-red-300">
                {list.moreError}
              </span>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

interface TimelineRowItemProps {
  row: TimelineRow;
  onActivate: (row: TimelineRow) => void;
}

/** One row: the time (the canonical instant on hover), title, `type · source`, the relation to the anchor, the work-item fields when present; links beside the button. */
function TimelineRowItem({ row, onActivate }: TimelineRowItemProps) {
  const time = formatEventTime(row.occurredAt);
  const relation = relationLabel(row.edgeType, row.direction);
  const fields = pickRowFields(row.metadata);
  const links = extractLinks(row.metadata);
  const hasFields = fields.status !== null || fields.priority !== null || fields.assignee !== null;

  return (
    <li data-node-id={row.id} data-node-type={row.nodeType} className="glass flex items-start justify-between gap-3 p-3">
      <button
        type="button"
        onClick={() => onActivate(row)}
        aria-label={`Open ${row.title || "(untitled)"} in the graph`}
        className="min-w-0 flex-1 rounded text-left focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <time dateTime={time.title} title={time.title} className="shrink-0 font-mono text-xs text-fg-muted">
            {time.text}
          </time>
          <span className="min-w-0 truncate text-sm font-medium text-fg">{row.title || "(untitled)"}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          <span>
            {row.nodeType} · {row.sourceSystem}
          </span>
          <span title={relation.title} className="rounded-full border border-hairline bg-surface-strong px-2 py-0.5 text-[11px]">
            {relation.text}
          </span>
          {hasFields && (
            <>
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
            </>
          )}
        </span>
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
