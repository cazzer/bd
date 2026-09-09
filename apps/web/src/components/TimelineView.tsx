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
// are ordinary text beside it — visible for the ones that discriminate,
// screen-reader text for the ones demoted below (see "How a page READS")
// — so a screen reader hears all of it rather than a label that replaced
// it. "Open in graph" pushes the anchor the same way, so back returns
// here with the chips as the address kept them.
// Links found in a row's metadata sit beside the title, never inside it.
//
// How a page READS (readable-graph-and-timeline, design.md decisions 7
// and 8). The flat list this replaced drew fifty identically sized,
// evenly spaced cards, each repeating the same date and the same
// `commit · git · belongs-to →` — three tokens of no discriminating
// power per row, on a page that conveyed order and nothing else. Four
// changes, all of them client-side derivations of the read this view
// already makes:
//
//   - DAY GROUPS. `groupRowsByDay` (lib/timelineRow.ts) splits the page
//     on the viewer's own calendar day; the day is named once on a
//     sticky header that stays visible while its rows are read, and a
//     row carries only its time of day.
//   - ELAPSED TIME AS SPACE. Each row is pushed down by the clamped log
//     of the interval above it — bounded at both ends, so a burst packs
//     at the floor and one ancient item cannot take the page. Past six
//     hours the gap also names itself ("18 hours earlier"), because
//     beyond the ceiling space alone stops being able to say how long.
//   - TYPE AS COLOUR. The same `getStoreSummary()`-ranked
//     `assignTypeColors` map GraphView derives, so a `commit` is the
//     same green here as on the canvas. Drawn as the row's left edge and
//     its chip's swatch.
//   - CONSTANT TEXT DEMOTED. `type · source` and the relation pill no
//     longer occupy the row body: the type is the colour edge plus a
//     short right-aligned label, and source and relation live in the
//     row's hover title and its screen-reader text, which still spells
//     the relation's DIRECTION out exactly as before.
//
// Day, not week (design.md's open question, answered from the rendered
// page): the sample anchor's fifty rows span four calendar days, so day
// grouping puts four headers on a page of fifty rows — often enough to
// be the unit a reader thinks in, rare enough that a header never
// approaches one per row. The failure mode week grouping guards against
// is a sparse timeline drawing a header per row; the gap marker already
// covers that case with better information (it names the interval),
// which week grouping would not. Revisit only if a real anchor is found
// whose rows are days apart AND whose headers outnumber its content.
//
// The chip counts are the loaded page's composition, not the store's
// (tasks.md 5.5): `timeline` answers one narrowing per call and reports
// no per-type breakdown, and design.md's Non-Goals rule out adding a
// procedure that would. So each chip counts the rows on screen, under a
// caption that names that scope, and a deselected chip — whose rows were
// never read — reports no number rather than a false zero. See lib/
// timelineRow.ts's own section header.
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
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { colorForNodeType } from "../graph/palette.js";
import { typeColorsForStore, type TypeCount } from "../graph/typePrevalence.js";
import { extractLinks, pickRowFields } from "../lib/feedRow.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import {
  addressTypesFor,
  chipCountLabel,
  chipCountsCaption,
  chosenTypes,
  countRowsByType,
  formatEventTime,
  formatTimeOfDay,
  GAP_FLOOR_PX,
  groupRowsByDay,
  linkHost,
  relationLabel,
  toggleType,
  type TimelineGap,
  type TypeSelection,
} from "../lib/timelineRow.js";
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
  /**
   * The narrowing these rows were LOADED under (bd-v1y review).
   *
   * Distinct from the address's current `chosen`, and the distinction is
   * load-bearing: while a new page is in flight the previous page's rows
   * stay on screen dimmed, so a chip the person just selected is already
   * in the address's set but has no rows in the shown page yet. Counting
   * against the address made such a chip print "0" — a claim that there
   * are none, about rows that had not been read. Counting against this
   * instead makes the deselected-chip guard fire for exactly the types
   * the shown rows cannot speak for.
   */
  chosen: readonly string[] | null;
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
  const [nodeTypeCounts, setNodeTypeCounts] = useState<TypeCount[]>([]);

  // The store's type ranking, read once on mount — the fourth read this
  // view makes, and the only one that is purely cosmetic. Best-effort
  // exactly as GraphView's `refreshStoreSummary` is: a failure leaves the
  // list empty, every type then resolves to `FALLBACK_COLOR`, and the
  // page draws with one neutral edge colour rather than surfacing an
  // error for a colour.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const summary = await trpc.getStoreSummary.query();
        if (!cancelled) setNodeTypeCounts(summary.nodeTypes);
      } catch {
        // best-effort — see the comment above
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The same map GraphView draws from (design.md decision 8), now via
   * one shared derivation rather than two copies of the same expression
   * — see `typeColorsForStore`. That is what makes "a type looks the
   * same across views" a property of the code rather than of two files
   * happening to agree.
   */
  const typeColors = useMemo(() => typeColorsForStore(nodeTypeCounts), [nodeTypeCounts]);

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
          chosen,
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

  // The rows as the page draws them — calendar-day groups, each row
  // carrying the gap above it (lib/timelineRow.ts). Pure, so it is
  // memoized on the loaded page's identity: `shown` changes only when a
  // read lands or "load more" appends, never per render.
  const shownRows = shown?.rows;
  const groups = useMemo(() => (shownRows === undefined ? [] : groupRowsByDay(shownRows)), [shownRows]);
  // The loaded page's type composition, for the chips — see the module
  // header on why this is the page's and not the store's.
  const rowTypeCounts = useMemo(() => countRowsByType(shownRows ?? []), [shownRows]);

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
          <div className="mb-4">
            <div role="group" aria-label="Node types" className="flex flex-wrap gap-2">
              {chips.map((type) => {
                const pressed = selection?.chosen?.includes(type) ?? false;
                // A count only once a page with rows is on screen: with
                // nothing loaded there is nothing to count, and a "0"
                // against no page at all would read as a claim about the
                // store rather than about what is shown.
                // `shown.chosen`, not `selection.chosen`: the counts
                // describe the rows on screen, so the narrowing they are
                // judged against has to be the one those rows were loaded
                // under. See ReadyPage.chosen.
                const count = shown === null || shown.rows.length === 0 ? null : chipCountLabel(type, shown.chosen, rowTypeCounts);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={pressed}
                    title={count?.title}
                    onClick={() => toggleChip(type)}
                    className={`flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${
                      pressed ? "border-accent/60 bg-accent/20 text-fg" : "border-hairline bg-surface text-fg-muted hover:text-fg"
                    }`}
                  >
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorForNodeType(type, typeColors) }} />
                    {type}
                    {/*
                      bd-v1y review: the count is the ONLY channel saying
                      "this would show nothing". An earlier version also
                      faded an empty chip with opacity-60 — but `empty` is
                      only ever true for a chip that IS selected, and a
                      deselected chip stayed at full opacity, so dim meant
                      on-but-empty and bright meant off. A reader decoding
                      "faded means off" got it exactly backwards, and the
                      fade was borrowing the affordance the pressed state
                      already spends. Emphasis is left to aria-pressed and
                      the border, and the number carries emptiness on its
                      own.
                    */}
                    {count?.text !== null && count?.text !== undefined && (
                      <span className={`font-mono tabular-nums ${count.empty ? "text-fg-muted/60" : "text-fg-muted"}`}>{count.text}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {shown !== null && shown.rows.length > 0 && <p className="mt-1.5 text-[11px] text-fg-muted">{chipCountsCaption(shown.rows.length, shown.hasMore)}</p>}
          </div>
        )}

        {errorMessage !== null && (
          <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </p>
        )}
        {errorMessage === null && copy !== null && <p className="glass p-4 text-sm text-fg-muted">{copy}</p>}

        {shown !== null && shown.rows.length > 0 && (
          <div role="group" aria-label="Timeline rows" aria-busy={pageLoading} className={`transition-opacity ${pageLoading ? "opacity-50" : ""}`}>
            {groups.map((group, index) => (
              // Keyed by position as well as day: two runs of one day are
              // two groups (lib/timelineRow.ts's `groupRowsByDay`), and
              // the key must stay unique when that happens.
              <section key={`${group.key}#${index}`} aria-label={group.label} style={marginForGap(group.gap)}>
                {group.gap?.label != null && <GapMarker label={group.gap.label} />}
                <h2 className="sticky top-0 z-10 mb-2 flex items-baseline gap-2 bg-ground px-2 py-2 text-xs font-semibold text-fg">
                  {group.label}
                  <span className="font-normal text-fg-muted">{group.entries.length}</span>
                </h2>
                <ol>
                  {group.entries.map(({ row, gap }) => (
                    <li key={row.id} style={marginForGap(gap)}>
                      {gap?.label != null && <GapMarker label={gap.label} />}
                      <TimelineRowItem row={row} typeColors={typeColors} />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
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

/** Roughly a `GapMarker`'s own height: taken out of a labelled gap's spacing so the marker sits INSIDE the space the interval earned rather than adding to it. */
const GAP_MARKER_PX = 22;

/** A gap drawn as space above the thing that follows it — nothing at all for the first row on the page, which has no interval above it. */
function marginForGap(gap: TimelineGap | null): CSSProperties | undefined {
  if (gap === null) {
    return undefined;
  }
  return { marginTop: gap.label === null ? gap.spacingPx : Math.max(GAP_FLOOR_PX, gap.spacingPx - GAP_MARKER_PX) };
}

/**
 * The named gap (design.md decision 7): past six hours the space alone
 * stops being able to say how long, so the interval says it in words.
 * Not `aria-hidden` — "18 hours earlier" is exactly what a reader who
 * cannot see the spacing is otherwise missing.
 */
function GapMarker({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-1 text-[11px] text-fg-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
      {label}
      <span aria-hidden="true" className="h-px flex-1 bg-hairline" />
    </p>
  );
}

interface TimelineRowItemProps {
  row: TimelineRow;
  /** The store-ranked type-colour map this view derives (design.md decision 8) — the same one GraphCanvas draws from. */
  typeColors: ReadonlyMap<string, string>;
}

/**
 * One row: its time of DAY (the day itself is on the group's header, the
 * full instant in the screen-reader text and on hover), the title as a
 * link into the graph, the node type as a colour edge and a short label,
 * the work-item fields when present; links from the metadata beside it,
 * named by their host.
 *
 * Source system and relation are no longer row text (spec: "Text that is
 * identical on every row of a page SHALL NOT occupy the row's primary
 * content" — every row of the sample page said `commit · git ·
 * belongs-to →`). They moved to the row's hover title and its sr-only
 * text, which keeps `relation.title`'s spelled-out DIRECTION verbatim:
 * the accessible name says as much as it ever did, the picture says less.
 */
function TimelineRowItem({ row, typeColors }: TimelineRowItemProps) {
  const clock = formatTimeOfDay(row.occurredAt);
  const instant = formatEventTime(row.occurredAt);
  const relation = relationLabel(row.edgeType, row.direction);
  const fields = pickRowFields(row.metadata);
  const links = extractLinks(row.metadata);
  const route = graphRouteFor(row.id);
  const color = colorForNodeType(row.nodeType, typeColors);
  const aside = `${row.nodeType} · ${row.sourceSystem} · ${relation.title}`;
  const hasFields = fields.status !== null || fields.priority !== null || fields.assignee !== null;

  return (
    // No `title` on the row container (bd-v1y review): it held the same
    // string as the sr-only span below, and assistive tech that surfaces
    // `title` as a description would announce that sentence twice on
    // every one of fifty rows. Before this change the two held DIFFERENT
    // strings, so the duplication arrived with it. The hover affordance
    // moved to the type label, which is aria-hidden.
    <div data-node-id={row.id} data-node-type={row.nodeType} className="glass flex items-stretch justify-between gap-3 p-3 hover:bg-surface-strong">
      <span aria-hidden="true" style={{ backgroundColor: color }} className="w-1 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <time dateTime={clock.iso ?? undefined} title={clock.title} className="shrink-0 font-mono text-xs text-fg-muted">
            {/* Sighted readers get the time alone — the day is on the header above. A screen reader, which has no header to look up at, gets the whole instant. */}
            <span aria-hidden="true">{clock.text}</span>
            <span className="sr-only">{instant.text}</span>
          </time>
          <a
            href={formatRoute(route)}
            onClick={pushOnPlainClick(route)}
            className="min-w-0 flex-1 rounded text-sm font-medium text-fg line-clamp-2 hover:underline focus:outline-none focus:ring-2 focus:ring-accent sm:line-clamp-1"
          >
            {row.title || "(untitled)"}
          </a>
          {/*
            The aside hangs here, on the visible type label — not on the
            row container. Mouse readers keep the hover reachability the
            spec asks for ("remains reachable for a row the person
            inspects"), and because this span is aria-hidden the string
            reaches the accessibility tree exactly once, through the
            sr-only span below.
          */}
          <span aria-hidden="true" title={aside} style={{ color }} className="shrink-0 text-[11px]">
            {row.nodeType}
          </span>
        </p>
        <span className="sr-only">{aside}</span>
        <p className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted ${hasFields ? "" : "hidden"}`}>
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
    </div>
  );
}
