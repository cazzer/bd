// The timeline view (timeline-view, design.md decision 5): for one anchor
// node, the items connected to it that carry an event time, newest first,
// narrowed to the node types the reader chooses out of the ones the
// `view` node names. Mounted by the shell (App.tsx) under `/timeline`,
// addressed by `?view=<id>&node=<anchor>&type=<t>&type=<t>` (lib/
// route.ts), and read-only: it never asks for a node's content and
// writes nothing.
//
// Reads, in three pieces of state. The view loads exactly as the feed
// does: `getNodes` for the view node, `viewFilterOf` (lib/viewFilter.ts,
// shared) for its filter — the renderer is not checked, so `/timeline`
// draws any view's filter as chips. The anchor is its own state keyed on
// `node` alone (the code view's `shown` shape): `getNodes([node])` for
// the heading, read once per anchor, so a chip toggle leaves the heading,
// the header link, and the header's height exactly as they were. The
// page is keyed on `(viewId, node, chosen)`: `timeline({ anchorId,
// nodeTypes, sourceSystems, limit })` with the chosen types (`chosenTypes`,
// lib/timelineRow.ts — the address's `type`s intersected with the view's
// `nodeTypes`, every chip when the address names none, `nodeTypes`
// omitted when the view names none) and the view's source systems spread
// in exactly as the feed spreads its filter into `list`. On first load
// the anchor and the page are read together; on a toggle only the page
// is. While a page loads, the previous page's rows — when they are the
// same anchor's under the same view — stay on screen dimmed under
// `aria-busy`, and the always-mounted `role="status"` line says
// "Loading…", so the header never changes height and the new count is
// announced when it lands. A stale answer is dropped by the effect's
// `cancelled` flag (the feed's pattern), and a `ready` view loaded for
// another address is never read from — `forViewId` on the view state,
// the code view's guard, keeps the page effect from issuing the old
// view's read under the new address in the flush where both effects run.
// Every chip deselected is no read at all and the "no type is chosen"
// state.
//
// "Load more" is the feed's: the previous answer's `nextCursor`, appended
// only while the view, anchor, and chosen set are unchanged — which is
// what enforces core's rule that a `TimelineCursor` is never replayed
// across anchors or narrowings (packages/core/src/timeline.ts).
//
// Navigation. A chip toggle formats the new route and `navigate`s with
// "replace" (design.md decision 4: a chip is a state of one listing, so
// back leaves the view rather than undoing a toggle); the shell re-reads
// the address and re-renders this component with new `types`. A row's
// title is a real link to `/graph?node=<row>` whose plain left click goes
// through `navigate(…, "push")` — middle-click, cmd-click, and copy-link
// work natively, and the row's time, type, source, relation, and fields
// are ordinary text beside it, so a screen reader hears all of it rather
// than a label that replaced it. "Open in graph" pushes the anchor the
// same way, so back returns here with the chips as the address kept them.
// Links found in a row's metadata sit beside the title, never inside it.
//
// The empty states — no view, not a view, no anchor, anchor not found,
// nothing timed, no type chosen — each keep the "Timeline" heading, the
// address, and a way to the graph (timeline-view/spec.md, "The timeline
// view is addressable": none "SHALL redirect or change the address").
// `/timeline?view=abc` parses and `getNodes` rejects the id with
// BAD_REQUEST, read as "names no view" the way the feed reads it; an
// anchor `getNodes` answers nothing for (or rejects), or that `timeline`
// reports NOT_FOUND, is "not found" — a BAD_REQUEST from `timeline` is
// not, since by then the anchor read has succeeded and what was refused
// is the view's filter or the page's own arguments, shown as the error it
// is (lib/viewFilter.ts's treatment). User copy never repeats a raw id:
// it is in the address bar.

import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { extractLinks, pickRowFields } from "../lib/feedRow.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { addressTypesFor, chosenTypes, formatEventTime, linkHost, relationLabel, toggleType, type TypeSelection } from "../lib/timelineRow.js";
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

/** What the header needs of a node: its id and title. */
interface NodeRef {
  id: string;
  title: string;
}

/** `forViewId` is the address the ready state was loaded for: a render can still hold the previous view's state after `viewId` changed, and the page effect must wait for the reload. */
type ViewState =
  | { kind: "no-view" }
  | { kind: "loading" }
  | { kind: "not-a-view" }
  | { kind: "error"; message: string }
  | { kind: "ready"; forViewId: string; view: NodeRef; filter: ViewFilter };

/** The anchor the address names, as `getNodes` answered: `missing` for BAD_REQUEST or an empty answer (no such node). Keyed on `node` alone. */
type AnchorState = { kind: "none" } | { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready"; node: NodeRef };

/** A loaded page. `key` is the `(viewId, node, chosen)` it was loaded for, compared by the load-more guard; `viewId`/`node` say whose rows these are, so a reload for the same anchor can keep them on screen. */
interface ReadyPage {
  kind: "ready";
  key: string;
  viewId: string;
  node: string;
  rows: TimelineRow[];
  hasMore: boolean;
  nextCursor: TimelineCursor | null;
  untimedCount: number;
  loadingMore: boolean;
  moreError: string | null;
}

/** The page. `loading` carries the previous page when it was the same anchor's under the same view — drawn dimmed until the new one lands. `anchor-missing` is `timeline`'s own NOT_FOUND. */
type PageState = { kind: "idle" } | { kind: "loading"; stale: ReadyPage | null } | { kind: "anchor-missing" } | { kind: "error"; message: string } | { kind: "none-chosen" } | ReadyPage;

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

/** The `(viewId, node, chosen)` a page is loaded for, as one comparable string; `null` chosen is "every type". */
function pageKeyOf(viewId: string, node: string, chosen: readonly string[] | null): string {
  return JSON.stringify([viewId, node, chosen]);
}

/** The route that opens `id` selected in the graph. */
function graphRouteFor(id: string): GraphRoute {
  return { view: "graph", q: null, types: [], node: id };
}

/**
 * A real `href` so a link is a link (middle-click, cmd-click, copy
 * address); a plain left click goes through `navigate` so the shell
 * swaps views without a page load, the way every in-app move does.
 */
function pushOnPlainClick(route: GraphRoute) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(route, "push");
  };
}

/** `n have no time`, with the verb agreeing. */
function untimedPhrase(n: number): string {
  return `${n} ${n === 1 ? "has" : "have"} no time`;
}

export function TimelineView({ viewId, node, types }: TimelineViewProps) {
  const [view, setView] = useState<ViewState>(viewId === null ? { kind: "no-view" } : { kind: "loading" });
  const [anchor, setAnchor] = useState<AnchorState>(node === null ? { kind: "none" } : { kind: "loading" });
  const [page, setPage] = useState<PageState>({ kind: "idle" });

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

  // The anchor, keyed on `node` alone: read beside the view on a deep
  // link, untouched by a chip toggle.
  useEffect(() => {
    if (node === null) {
      setAnchor({ kind: "none" });
      return;
    }
    let cancelled = false;
    setAnchor({ kind: "loading" });

    async function load(id: string) {
      try {
        const lookup = await trpc.getNodes.query({ ids: [id] });
        if (cancelled) return;
        const found = lookup.nodes[0];
        setAnchor(found ? { kind: "ready", node: { id: found.id, title: found.title } } : { kind: "missing" });
      } catch (err) {
        if (cancelled) return;
        setAnchor(isBadRequest(err) ? { kind: "missing" } : { kind: "error", message: messageOf(err, "Failed to load this node.") });
      }
    }

    void load(node);
    return () => {
      cancelled = true;
    };
  }, [node]);

  // What the address chooses out of what the view names — pure (lib/
  // timelineRow.ts), `null` until the view for this address is loaded.
  // Memoized on the address's types as text, not the array: the shell
  // hands this component a fresh `types` array on every navigation, and
  // a popstate to the same address must not read the page again.
  const typesKey = JSON.stringify(types);
  const selection = useMemo<TypeSelection | null>(
    () => (view.kind === "ready" && view.forViewId === viewId ? chosenTypes(JSON.parse(typesKey) as string[], view.filter.nodeTypes ?? null) : null),
    [view, viewId, typesKey],
  );
  const sourceSystems = view.kind === "ready" ? view.filter.sourceSystems : undefined;
  const pageKey = selection !== null && viewId !== null && node !== null ? pageKeyOf(viewId, node, selection.chosen) : null;

  // The page, keyed on `(viewId, node, chosen)`: `selection` changes
  // identity only when the loaded view or the address's types do, and
  // `sourceSystems` only with the loaded view. With every chip deselected
  // nothing is read.
  useEffect(() => {
    if (selection === null || viewId === null || node === null) {
      setPage({ kind: "idle" });
      return;
    }
    const { chosen, none } = selection;
    if (none) {
      setPage({ kind: "none-chosen" });
      return;
    }
    let cancelled = false;
    const forViewId = viewId;
    const key = pageKeyOf(viewId, node, chosen);
    // Keep the previous rows on screen, dimmed, when they are this
    // anchor's under this view (a chip toggle); another address's rows
    // are dropped.
    setPage((previous) => {
      const held = previous.kind === "ready" ? previous : previous.kind === "loading" ? previous.stale : null;
      return { kind: "loading", stale: held !== null && held.viewId === viewId && held.node === node ? held : null };
    });

    async function load(anchorId: string) {
      try {
        const answer = await trpc.timeline.query({ anchorId, nodeTypes: chosen ?? undefined, sourceSystems: sourceSystems ?? undefined, limit: PAGE_SIZE });
        if (cancelled) return;
        setPage({
          kind: "ready",
          key,
          viewId: forViewId,
          node: anchorId,
          rows: answer.rows,
          hasMore: answer.hasMore,
          nextCursor: answer.nextCursor,
          untimedCount: answer.untimedCount,
          loadingMore: false,
          moreError: null,
        });
      } catch (err) {
        if (cancelled) return;
        setPage(isNotFound(err) ? { kind: "anchor-missing" } : { kind: "error", message: messageOf(err, "Failed to load this timeline.") });
      }
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
    if (page.kind !== "ready" || page.loadingMore || page.nextCursor === null || node === null || selection === null || page.key !== pageKey) {
      return;
    }
    const { key, nextCursor: cursor } = page;
    setPage({ ...page, loadingMore: true, moreError: null });
    try {
      const answer = await trpc.timeline.query({ anchorId: node, nodeTypes: selection.chosen ?? undefined, sourceSystems: sourceSystems ?? undefined, limit: PAGE_SIZE, cursor });
      setPage((previous) =>
        previous.kind === "ready" && previous.key === key && previous.nextCursor === cursor
          ? { ...previous, rows: [...previous.rows, ...answer.rows], hasMore: answer.hasMore, nextCursor: answer.nextCursor, untimedCount: answer.untimedCount, loadingMore: false }
          : previous,
      );
    } catch (err) {
      const message = messageOf(err, "Failed to load more.");
      setPage((previous) => (previous.kind === "ready" && previous.key === key && previous.nextCursor === cursor ? { ...previous, loadingMore: false, moreError: message } : previous));
    }
  }

  /** A chip toggle (timeline-view/spec.md, "Deselecting a type"): the address rewritten in place, never a history entry. */
  function toggleChip(type: string) {
    if (selection === null || selection.chosen === null) {
      return;
    }
    navigate({ view: "timeline", viewId, node, types: addressTypesFor(toggleType(selection.chosen, type)) }, "replace");
  }

  const viewTitle = view.kind === "ready" ? view.view.title || "(untitled view)" : null;
  const anchorRef = anchor.kind === "ready" ? anchor.node : null;
  const anchorMissing = anchor.kind === "missing" || page.kind === "anchor-missing";
  // The graph link names the anchor once it is known; before that, or in
  // an empty state, it is the bare graph.
  const graphRoute: GraphRoute = anchorRef !== null ? graphRouteFor(anchorRef.id) : GRAPH_HOME;
  const heading = anchorRef !== null && viewTitle !== null ? `${anchorRef.title || "(untitled)"} · ${viewTitle}` : "Timeline";

  // The rows on screen: the loaded page, or the previous page dimmed
  // while the next loads.
  const shown: ReadyPage | null = page.kind === "ready" ? page : page.kind === "loading" ? page.stale : null;
  const pageLoading = page.kind === "loading";

  // The status line, always mounted so the header keeps its height and a
  // change is announced: the count (or the one zero-row sentence) while a
  // page is shown, "Loading…" while anything loads, the view's name while
  // a view is loaded but no anchor is (so the "choose a node" state names
  // the view, as the spec asks), empty when the body carries the copy.
  let status = "";
  if (view.kind === "loading" || (view.kind === "ready" && view.forViewId !== viewId)) {
    status = "Loading…";
  } else if (view.kind === "ready" && node === null) {
    status = viewTitle ?? "";
  } else if (view.kind !== "ready" || anchorMissing || anchor.kind === "error") {
    status = "";
  } else if (anchor.kind === "loading" || pageLoading || page.kind === "idle") {
    status = "Loading…";
  } else if (page.kind === "error") {
    status = "";
  } else if (page.kind === "none-chosen") {
    status = "No type is chosen.";
  } else if (page.kind === "ready") {
    if (page.rows.length === 0) {
      status = page.untimedCount === 0 ? "Nothing matching the selection is connected to this node." : `Nothing connected to this node carries a time — ${page.untimedCount} ${page.untimedCount === 1 ? "has" : "have"} none.`;
    } else {
      status = `${page.rows.length} shown${page.hasMore ? " · more exist" : ""}${page.untimedCount > 0 ? ` · ${untimedPhrase(page.untimedCount)}` : ""}`;
    }
  }

  // The chip bar: drawn whenever the view names types and an anchor is
  // addressed, in every page state — the chips are the address's, not
  // the page's, so they stay while a page loads or when nothing is chosen.
  const chips = selection?.chips ?? null;
  const showChips = chips !== null && node !== null && !anchorMissing;

  // The body's one paragraph of copy, for the states with no page to draw.
  let copy: string | null = null;
  if (view.kind === "no-view") {
    copy = "No view is named in the address.";
  } else if (view.kind === "not-a-view") {
    copy = "The address does not name a view.";
  } else if (view.kind === "ready" && view.forViewId === viewId && node === null) {
    copy = "Choose a node in the graph to see its timeline.";
  } else if (view.kind === "ready" && anchorMissing) {
    copy = "That node was not found.";
  }
  // The anchor's state outranks the page's error: a malformed or unknown
  // anchor makes both reads fail, and "not found" is the truth of it. A
  // page error is shown only once the anchor is known to exist — then it
  // is the view's filter or the page's own arguments that were refused.
  const errorMessage = view.kind === "error" ? view.message : anchor.kind === "error" ? anchor.message : anchor.kind === "ready" && page.kind === "error" ? page.message : null;

  return (
    // `body` is `overflow: hidden` (index.css, for the canvas), so this
    // element is the page's own scroll container.
    <main className="h-dvh w-screen overflow-y-auto">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <header className="glass mb-4 flex items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <h1 className="break-words text-base font-semibold text-fg sm:truncate">{heading}</h1>
            <p className="mt-0.5 min-h-4 text-xs text-fg-muted" role="status">
              {status}
            </p>
          </div>
          <a href={formatRoute(graphRoute)} onClick={pushOnPlainClick(graphRoute)} className="shrink-0 rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
            {graphRoute.node === null ? "Open the graph" : "Open in graph"}
          </a>
        </header>

        {showChips && (
          <div role="group" aria-label="Node types" className="mb-4 flex flex-wrap gap-2">
            {chips.map((type) => {
              const pressed = selection?.chosen?.includes(type) ?? false;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => toggleChip(type)}
                  className={`min-h-11 rounded-full border px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${
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

        {shown !== null && shown.rows.length > 0 && (
          <ol aria-label="Timeline rows" aria-busy={pageLoading} className={`space-y-2 transition-opacity ${pageLoading ? "opacity-50" : ""}`}>
            {shown.rows.map((row) => (
              <TimelineRowItem key={row.id} row={row} />
            ))}
          </ol>
        )}

        {page.kind === "ready" && page.hasMore && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={page.loadingMore}
              className="min-h-11 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:min-h-0"
            >
              {page.loadingMore ? "Loading…" : "Load more"}
            </button>
            {page.moreError && (
              <span role="alert" className="text-xs text-red-300">
                {page.moreError}
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
}

/**
 * One row: the time (the canonical instant on hover), the title as a link
 * into the graph, `type · source`, the relation to the anchor (the arrow
 * for sighted readers, the spelled-out direction for a screen reader),
 * the work-item fields when present; links from the metadata beside it,
 * named by their host.
 */
function TimelineRowItem({ row }: TimelineRowItemProps) {
  const time = formatEventTime(row.occurredAt);
  const relation = relationLabel(row.edgeType, row.direction);
  const fields = pickRowFields(row.metadata);
  const links = extractLinks(row.metadata);
  const route = graphRouteFor(row.id);

  return (
    <li data-node-id={row.id} data-node-type={row.nodeType} className="glass flex items-start justify-between gap-3 p-3 hover:bg-surface-strong">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <time dateTime={time.iso ?? undefined} title={time.title} className="shrink-0 font-mono text-xs text-fg-muted">
            {time.text}
          </time>
          <a href={formatRoute(route)} onClick={pushOnPlainClick(route)} className="min-w-0 rounded text-sm font-medium text-fg line-clamp-2 hover:underline focus:outline-none focus:ring-2 focus:ring-accent sm:line-clamp-1">
            {row.title || "(untitled)"}
          </a>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          <span>
            {row.nodeType} · {row.sourceSystem}
          </span>
          <span title={relation.title} className="rounded-full border border-hairline bg-surface-strong px-2 py-0.5 text-[11px]">
            <span aria-hidden="true">{relation.text}</span>
            <span className="sr-only">{relation.title}</span>
          </span>
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
        </p>
      </div>
      {links.length > 0 && (
        <span className="flex shrink-0 flex-wrap justify-end gap-2 text-xs">
          {links.map((link) => (
            <a key={link.key} href={link.href} title={link.key} target="_blank" rel="noopener noreferrer" className="-m-2 rounded p-2 text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
              {linkHost(link.href)}
            </a>
          ))}
        </span>
      )}
    </li>
  );
}
