// The board view (live-beads-board, design.md decisions 6-7): work items of
// the chosen projects as columns (Ready ... Closed) crossed with epic lanes,
// kept current as the trackers change. Mounted by the shell (App.tsx) under
// `/board`, addressed by `?view=<id>&project=<key>...&item=<bead id>`
// (lib/route.ts). The board itself writes nothing; its one write is a review
// decision, taken in the item drawer (ReviewDrawer.tsx).
//
// The view node loads like the feed's does (`getNodes`, `viewFilterOf`) and
// its renderer must be `board`; an unknown view and a view of another
// renderer are empty states at this address, never redirects. No view at
// all is a board of every registered project (board-visual-reviews, design.md
// decision 3), so the review CLI's link needs no view id. The chips are the
// view filter's `project` predicate, or every registered project when it
// names none or there is no view (lib/boardRow.ts); the chosen set lives in
// the address, so a toggle is a history push and a reload reproduces the
// board.
//
// The drawer (board-visual-reviews, task 4.4): activating a card pushes its
// external id as `item`; closing pushes the address without it and returns
// focus to the card. The drawer's project is the card's, or the one chosen
// project before the item is on the board (lib/reviewDrawer.ts); it re-reads
// the item after every board read (`boardVersion`), which is how a waiting
// drawer opens without a reload.
//
// Live: one effect owns the reads, and registers with the tab's one live
// stream (lib/liveStream.ts, review-queue design.md decision 2), which it
// shares with the review queue. It reads in `onStarted`, which the registry
// calls on every (re)start of the stream and at once when the stream is
// already started — so a change that lands between the read and the stream
// cannot be missed, and a reconnect or a tab shown again re-reads. The
// registry holds no stream while the tab is hidden (its header says why);
// the last board stays on screen meanwhile. Each event schedules a read
// 150 ms out (a burst collapses to one, and a continuous stream cannot defer
// it past 1 s), and reads never overlap: one requested while another runs
// sets a dirty flag and exactly one follow-up runs after it, so sustained
// writes cannot starve the board (lib/readScheduler.ts). The registration is
// keyed on the view alone; a chip toggle re-reads on it (the chosen projects
// live in a ref), and the previous board stays on screen, filtered to the
// chosen chips and marked aria-busy, until the answer lands.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { subscribeLive, useLiveState } from "../lib/liveStream.js";
import { navigate } from "../lib/navigate.js";
import { createReadScheduler, READ_DEBOUNCE_MS, READ_MAX_WAIT_MS } from "../lib/readScheduler.js";
import {
  addHighlights,
  BOARD_COLUMN_ORDER,
  buildLanes,
  chosenChips,
  filterProjects,
  nextHighlightExpiry,
  offeredChips,
  pruneHighlights,
  readableProjects,
  toggleChip,
  type BoardCardRow,
  type BoardLane,
  type Highlights,
} from "../lib/boardRow.js";
import { drawerProject } from "../lib/reviewDrawer.js";
import { formatRoute, type BoardRoute, type GraphRoute } from "../lib/route.js";
import { viewFilterOf, type ViewNode } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";

const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

type ViewState =
  | { kind: "loading" }
  | { kind: "not-a-view" }
  | { kind: "wrong-renderer"; title: string; renderer: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; forViewId: string | null; title: string; viewProjects: string[] | null };

/** The board with no `view` in its address: every registered project. */
const ALL_PROJECTS: ViewState = { kind: "ready", forViewId: null, title: "All projects", viewProjects: null };

type BeadsProjectsAnswer = Awaited<ReturnType<typeof trpc.beadsProjects.query>>["projects"];
type BoardAnswer = Awaited<ReturnType<typeof trpc.board.query>>;
interface BoardData {
  registry: BeadsProjectsAnswer;
  board: Pick<BoardAnswer, "cards" | "epics" | "omittedClosed" | "truncated">;
}

const EMPTY_BOARD: BoardData["board"] = { cards: [], epics: [], omittedClosed: {}, truncated: false };

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function isBadRequest(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { data?: { code?: string } }).data?.code === "BAD_REQUEST";
}

export interface BoardViewProps {
  viewId: string | null;
  projects: string[];
  /** The external id whose drawer is open; null when none is. */
  item: string | null;
}

export function BoardView({ viewId, projects, item }: BoardViewProps) {
  const [viewState, setViewState] = useState<ViewState>(viewId === null ? ALL_PROJECTS : { kind: "loading" });
  const [data, setData] = useState<BoardData | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [eventErrors, setEventErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [highlights, setHighlights] = useState<Highlights>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [toggledLanes, setToggledLanes] = useState<ReadonlySet<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [boardVersion, setBoardVersion] = useState(0);
  const boardRegionRef = useRef<HTMLDivElement>(null);
  /** Unsent drawer messages by item, so closing the drawer or switching cards never drops one. */
  const drafts = useRef(new Map<string, string>());
  /** The project each opened item resolved to (see openProject). */
  const pinnedProjects = useRef(new Map<string, string>());
  const followCardUntil = useRef(0);
  const returnFocusTo = useRef<string | null>(null);
  const wide = useWideDrawer();
  const live = useLiveState();
  const projectsRef = useRef(projects);
  const appliedKeyRef = useRef(projects.join("\u0000"));
  const readRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setData(null);
    setReadError(null);
    setEventErrors(new Map());
    setHighlights(new Map());
    setToggledLanes(new Set());
    setAnnouncement("");
    if (viewId === null) {
      setViewState(ALL_PROJECTS);
      return;
    }
    let cancelled = false;
    setViewState({ kind: "loading" });
    async function load(id: string) {
      let node: ViewNode | undefined;
      try {
        node = (await trpc.getNodes.query({ ids: [id] })).nodes[0];
      } catch (err) {
        if (cancelled) return;
        setViewState(isBadRequest(err) ? { kind: "not-a-view" } : { kind: "error", message: messageOf(err, "Failed to load this view.") });
        return;
      }
      if (cancelled) return;
      if (!node || node.nodeType !== "view") {
        setViewState({ kind: "not-a-view" });
        return;
      }
      const renderer = (node.metadata as Record<string, unknown>)["renderer"];
      if (renderer !== "board") {
        setViewState({ kind: "wrong-renderer", title: node.title, renderer: typeof renderer === "string" ? renderer : "none" });
        return;
      }
      const where = (viewFilterOf(node) as { where?: unknown } | null)?.where;
      setViewState({ kind: "ready", forViewId: id, title: node.title, viewProjects: filterProjects(where) });
    }
    void load(viewId);
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  const view = viewState.kind === "ready" && viewState.forViewId === viewId ? viewState : null;
  const projectsKey = projects.join("\u0000");

  // The live effect (see the header): register with the live stream, read in onStarted.
  useEffect(() => {
    if (view === null) return;
    const viewProjects = view.viewProjects;
    let disposed = false;
    const pending = new Set<string>();

    async function readOnce() {
      const ids = [...pending];
      const address = projectsRef.current;
      try {
        let registry: BeadsProjectsAnswer;
        let board: BoardData["board"];
        if (viewProjects !== null) {
          // The chips are known without the registry, so both reads go out together.
          const readable = readableProjects(chosenChips(offeredChips(viewProjects, []), address));
          const [reg, b] = await Promise.all([trpc.beadsProjects.query(), readable.length > 0 ? trpc.board.query({ projects: readable }) : Promise.resolve(EMPTY_BOARD)]);
          registry = reg.projects;
          board = b;
        } else {
          registry = (await trpc.beadsProjects.query()).projects;
          const readable = readableProjects(chosenChips(offeredChips(null, registry.map((p) => p.key)), address));
          board = readable.length > 0 ? await trpc.board.query({ projects: readable }) : EMPTY_BOARD;
        }
        if (disposed) return;
        for (const id of ids) pending.delete(id);
        setData({ registry, board });
        setBoardVersion((v) => v + 1);
        setReadError(null);
        setEventErrors(new Map());
        const shown = new Set(board.cards.map((c) => c.id));
        const updated = ids.filter((id) => shown.has(id));
        if (updated.length > 0) {
          setHighlights((h) => addHighlights(h, updated, Date.now()));
          setAnnouncement(`${updated.length} item${updated.length === 1 ? "" : "s"} updated`);
        }
      } catch (err) {
        if (!disposed) setReadError(messageOf(err, "Failed to read the board."));
      }
    }

    const scheduler = createReadScheduler({
      read: readOnce,
      debounceMs: READ_DEBOUNCE_MS,
      maxWaitMs: READ_MAX_WAIT_MS,
      onBusyChange: setReading,
    });
    readRef.current = () => scheduler.run();
    const unsubscribe = subscribeLive({
      onStarted: () => {
        if (!disposed) scheduler.run();
      },
      onEvent: (event) => {
        if (disposed) return;
        if (event.kind === "changed") {
          for (const id of event.changedNodeIds) pending.add(id);
          scheduler.schedule();
        } else {
          setEventErrors((prev) => new Map(prev).set(event.project, event.message));
        }
      },
      onError: (err) => {
        if (disposed) return;
        // No stream (e.g. no watcher on this server): the board still reads once, it just does not stay current.
        setReadError(messageOf(err, "The live update stream failed."));
        scheduler.run();
      },
    });

    return () => {
      disposed = true;
      readRef.current = null;
      scheduler.dispose();
      unsubscribe();
      setReading(false);
    };
  }, [view?.forViewId]);

  // A chip toggle re-reads on the live registration instead of re-registering.
  useEffect(() => {
    if (appliedKeyRef.current === projectsKey) return;
    appliedKeyRef.current = projectsKey;
    projectsRef.current = projects;
    readRef.current?.();
  }, [projectsKey]);

  // Highlights expire on their own clock.
  useEffect(() => {
    const next = nextHighlightExpiry(highlights);
    if (next === null) return;
    const timer = setTimeout(() => setHighlights((h) => pruneHighlights(h, Date.now())), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [highlights]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const outcomes = await trpc.refreshBoard.mutate();
      const failed = outcomes.filter((o) => !o.ok);
      setEventErrors(new Map(failed.map((o) => [o.project, o.ok ? "" : o.error])));
      setRefreshNote(failed.length > 0 ? `Refreshed; ${failed.length} failed.` : `Refreshed ${outcomes.length} project${outcomes.length === 1 ? "" : "s"}.`);
      readRef.current?.();
    } catch (err) {
      setRefreshNote(messageOf(err, "Refresh failed."));
    } finally {
      setRefreshing(false);
    }
  }

  const offered = view && data ? offeredChips(view.viewProjects, data.registry.map((p) => p.key)) : [];
  const chosen = chosenChips(offered, projects);

  // A hand-edited or stale address is rewritten to the canonical selection (chip order, empty when every chip is chosen).
  const canonicalProjects = chosen.length === offered.length ? [] : chosen;
  const canonicalKey = canonicalProjects.join("\u0000");
  useEffect(() => {
    if (offered.length === 0 || canonicalKey === projectsKey) return;
    navigate({ view: "board", viewId, projects: canonicalProjects, item }, "replace");
  }, [viewId, offered.length, canonicalKey, projectsKey, item]);

  const errors = new Map<string, string>();
  if (data) {
    for (const p of data.registry) if (p.lastIngest && !p.lastIngest.ok) errors.set(p.key, p.lastIngest.error);
  }
  for (const [project, message] of eventErrors) errors.set(project, message);
  const shownErrors = [...errors].filter(([project]) => chosen.includes(project));

  const cards = data ? data.board.cards.filter((c) => chosen.includes(c.project)) : [];
  const epics = data ? data.board.epics : [];
  const lanes = buildLanes(cards, epics);
  const omitted = data ? Object.entries(data.board.omittedClosed).filter(([project]) => chosen.includes(project)) : [];

  function toggleProject(key: string) {
    if (chosen.length === 1 && chosen[0] === key) return;
    navigate({ view: "board", viewId, projects: toggleChip(offered, projects, key), item }, "push");
  }

  const route: BoardRoute = { view: "board", viewId, projects, item };
  const drawerOpen = view !== null && item !== null;

  // The drawer's project. A project is pinned for an item only once it is
  // confirmed — a card of that project shows the item, or `boardItem` found
  // it there — so it stays put after that; until then it is a guess (the
  // card's, else the address's or the board's single project, enough to
  // start reading before the first board read), and a card that later shows
  // the item elsewhere wins. Pinned in effects and callbacks, never in render.
  const cardProject = item === null ? undefined : cards.find((c) => c.externalId === item)?.project;
  const openProject = item === null ? null : (pinnedProjects.current.get(item) ?? drawerProject(item, cards, data ? chosen : projects));
  useEffect(() => {
    if (item !== null && cardProject !== undefined && !pinnedProjects.current.has(item)) pinnedProjects.current.set(item, cardProject);
  }, [item, cardProject]);

  // After a decision, the card is kept in view while re-reads move it.
  useEffect(() => {
    if (item === null || Date.now() > followCardUntil.current) return;
    document.querySelector(`li[data-external-id="${CSS.escape(item)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [boardVersion, item]);

  // Focus returns to the card once the drawer is gone (and, at phone width,
  // the board is no longer inert), or to the board when the card is not shown.
  useEffect(() => {
    const closed = returnFocusTo.current;
    if (item !== null || closed === null) return;
    returnFocusTo.current = null;
    const link = document.querySelector<HTMLAnchorElement>(`li[data-external-id="${CSS.escape(closed)}"] a`);
    (link ?? boardRegionRef.current)?.focus();
  }, [item]);

  function closeDrawer() {
    returnFocusTo.current = item;
    navigate({ ...route, item: null }, "push");
  }

  function toggleLane(lane: BoardLane) {
    const id = lane.epicId ?? "";
    setToggledLanes((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const heading = view ? view.title || "(untitled view)" : "Board";

  return (
    <main className={`flex h-dvh w-screen flex-col overflow-hidden ${drawerOpen ? "sm:pr-[492px]" : ""}`}>
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <header inert={drawerOpen && !wide} className="glass m-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <h1 className="min-w-0 truncate text-base font-semibold text-fg">{heading}</h1>
        {view && offered.length > 0 && (
          <div role="group" aria-label="Projects" className="flex flex-wrap gap-1.5">
            {offered.map((key) => {
              const on = chosen.includes(key);
              const locked = on && chosen.length === 1;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  aria-disabled={locked ? "true" : undefined}
                  title={locked ? "At least one project must stay selected" : undefined}
                  onClick={() => toggleProject(key)}
                  className={`min-h-11 rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${locked ? "cursor-not-allowed " : ""}${
                    on ? "border-accent bg-accent/20 text-fg" : "border-hairline text-fg-muted hover:bg-surface-strong"
                  }`}
                >
                  {key}
                </button>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-fg-muted">
          <span role="status" aria-live="polite">
            {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Not live"}
          </span>
          {view && (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="min-h-11 rounded-lg border border-hairline px-3 py-1 font-medium sm:min-h-0 text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          <a
            href={formatRoute(GRAPH_HOME)}
            onClick={(e) => openGraphHome(e)}
            className="rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
          >
            Open the graph
          </a>
        </div>
      </header>

      <div inert={drawerOpen && !wide} className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {viewState.kind === "not-a-view" && <Empty>The address does not name a view.</Empty>}
        {viewState.kind === "wrong-renderer" && (
          <Empty>
            The view “{viewState.title || "(untitled)"}” draws as {viewState.renderer}, not as a board.
          </Empty>
        )}
        {(viewState.kind === "loading" || (viewState.kind === "ready" && view === null)) && <Empty>Loading…</Empty>}
        {viewState.kind === "error" && (
          <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {viewState.message}
          </p>
        )}

        {view && (
          <>
            {readError && (
              <p role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                {readError}
              </p>
            )}
            {shownErrors.length > 0 && (
              <ul role="alert" aria-label="Project errors" className="space-y-1 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                {shownErrors.map(([project, message]) => (
                  <li key={project}>
                    <span className="font-medium">{project}</span>: {message} (showing its last loaded items)
                  </li>
                ))}
              </ul>
            )}
            {(omitted.length > 0 || data?.board.truncated || refreshNote) && (
              <p role="status" className="text-xs text-fg-muted">
                {omitted.length > 0 && <>Older closed items not shown: {omitted.map(([project, n]) => `${project} ${n}`).join(", ")}. </>}
                {data?.board.truncated && <>The board is too large to show in full. </>}
                {refreshNote}
              </p>
            )}
            {!data && !readError && <Empty>Loading…</Empty>}
            {data && offered.length === 0 && <Empty>No beads project is registered. Load one with pnpm ingest:beads.</Empty>}
            {data && offered.length > 0 && (
              <div ref={boardRegionRef} className="glass relative min-h-0 flex-1 overflow-auto" aria-label="Board" role="region" tabIndex={0} aria-busy={reading}>
                {reading && <div aria-hidden="true" className="sticky top-0 z-20 h-0.5 w-full animate-pulse bg-accent" />}
                <p className="sr-only" role="status" aria-live="polite">
                  {announcement}
                </p>
                <div className="min-w-[84.5rem] p-3">
                  <div className="sticky top-0 z-10 grid grid-cols-[repeat(5,minmax(16rem,1fr))] gap-3 bg-ground pb-2">
                    {BOARD_COLUMN_ORDER.map((col) => (
                      <h2 key={col.id} className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                        {col.label} <span className="font-normal">{cards.filter((c) => c.column === col.id).length}</span>
                      </h2>
                    ))}
                  </div>
                  {lanes.length === 0 && <p className="py-6 text-sm text-fg-muted">No items on this board.</p>}
                  {lanes.map((lane) => (
                    <LaneSection
                      key={lane.epicId ?? "no-epic"}
                      lane={lane}
                      open={lane.collapsedByDefault === toggledLanes.has(lane.epicId ?? "")}
                      onToggle={() => toggleLane(lane)}
                      highlights={highlights}
                      route={route}
                      selected={item === null ? null : { externalId: item, project: openProject }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {drawerOpen && item !== null && (
        <ReviewDrawer
          key={item}
          project={openProject}
          item={item}
          boardLoaded={data !== null}
          boardVersion={boardVersion}
          initialDraft={drafts.current.get(item) ?? ""}
          onDraftChange={(draft) => {
            if (draft.trim() === "") drafts.current.delete(item);
            else drafts.current.set(item, draft);
          }}
          onDecided={() => {
            followCardUntil.current = Date.now() + 15_000;
          }}
          onProjectConfirmed={(project) => {
            if (!pinnedProjects.current.has(item)) pinnedProjects.current.set(item, project);
          }}
          onClose={closeDrawer}
        />
      )}
    </main>
  );
}

function openGraphHome(e: MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(GRAPH_HOME, "push");
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="glass p-4 text-sm text-fg-muted">{children}</p>;
}

interface SelectedCard {
  externalId: string;
  project: string | null;
}

function isSelected(card: BoardCardRow, selected: SelectedCard | null): boolean {
  return selected !== null && card.externalId === selected.externalId && (selected.project === null || card.project === selected.project);
}

function LaneSection({
  lane,
  open,
  onToggle,
  highlights,
  route,
  selected,
}: {
  lane: BoardLane;
  open: boolean;
  onToggle: () => void;
  highlights: Highlights;
  route: BoardRoute;
  selected: SelectedCard | null;
}) {
  return (
    <section aria-label={lane.title} className="border-t border-hairline py-2">
      <h3 className="mb-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-h-11 max-w-full items-center gap-2 rounded text-left sm:min-h-0 text-sm font-medium text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <span aria-hidden="true" className="text-fg-muted">
            {open ? "▾" : "▸"}
          </span>
          <span className="truncate">{lane.title}</span>
          {lane.status && <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-normal text-fg-muted">{lane.status}</span>}
          <span className="shrink-0 text-xs font-normal text-fg-muted">{lane.cardCount}</span>
        </button>
      </h3>
      {open && (
        <div className="grid grid-cols-[repeat(5,minmax(16rem,1fr))] gap-3">
          {BOARD_COLUMN_ORDER.map((col) =>
            lane.columns[col.id].length === 0 ? (
              <div key={col.id} className="min-h-4" />
            ) : (
              <ul key={col.id} role="list" aria-label={`${lane.title}: ${col.label}`} className="space-y-2">
                {lane.columns[col.id].map((card) => (
                  <CardItem key={card.id} card={card} highlighted={highlights.has(card.id)} route={route} selected={isSelected(card, selected)} />
                ))}
              </ul>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function CardItem({ card, highlighted, route, selected }: { card: BoardCardRow; highlighted: boolean; route: BoardRoute; selected: boolean }) {
  const target: BoardRoute = { ...route, item: card.externalId };
  function open(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(target, "push");
  }
  return (
    <li data-node-id={card.id} data-external-id={card.externalId} data-highlighted={highlighted ? "true" : undefined}>
      <a
        href={formatRoute(target)}
        onClick={open}
        aria-current={selected ? "true" : undefined}
        className={`block rounded-lg border bg-surface-strong p-2.5 text-left transition-shadow focus:outline-none focus:ring-2 focus:ring-accent ${
          selected ? "border-accent ring-2 ring-accent" : highlighted ? "border-accent ring-2 ring-accent/60" : "border-hairline hover:border-accent/50"
        }`}
      >
        <span className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
          <span className="truncate font-mono">{card.externalId}</span>
          {card.review && <span className="shrink-0 rounded-full border border-accent/60 bg-accent/15 px-1.5 py-0.5 text-fg">review</span>}
          {highlighted && <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5 text-accent">updated</span>}
          {card.blockedFlag &&<span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-300">blocked</span>}
        </span>
        <span className="mt-1 block text-sm text-fg">{card.title || "(untitled)"}</span>
        <span className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-fg-muted">
          <span className="rounded-full border border-hairline px-1.5 py-0.5">P{card.priority}</span>
          {card.issueType && <span className="rounded-full border border-hairline px-1.5 py-0.5">{card.issueType}</span>}
          <span className="rounded-full border border-hairline px-1.5 py-0.5">{card.project}</span>
        </span>
      </a>
    </li>
  );
}

