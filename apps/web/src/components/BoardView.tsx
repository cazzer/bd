// The board view (live-beads-board, design.md decisions 6-7): work items of
// the chosen projects as columns (Ready ... Closed) crossed with epic lanes,
// kept current as the trackers change. Mounted by the shell (App.tsx) under
// `/board`, addressed by `?view=<id>&project=<key>...` (lib/route.ts), and
// read-only: it writes nothing and never asks for a node's content.
//
// The view node loads like the feed's does (`getNodes`, `viewFilterOf`) and
// its renderer must be `board`; no view, an unknown view, and a view of
// another renderer are empty states at this address, never redirects. The
// chips are the view filter's `project` predicate, or every registered
// project when it names none (lib/boardRow.ts); the chosen set lives in the
// address, so a toggle is a history push and a reload reproduces the board.
//
// Live: one effect owns the subscription and the reads. It subscribes to
// `boardEvents` FIRST and reads in `onStarted` — which the tRPC SSE link
// calls on every (re)connection — so a change that lands between the read
// and the subscription cannot be missed, and a reconnect re-reads. Each
// event schedules a read 150 ms out (a burst collapses to one), and a
// generation counter drops any read that a newer one has superseded. The
// effect is keyed on the view and the address's projects, so a chip toggle
// re-subscribes and re-reads; the previous board stays on screen, filtered
// to the chosen chips, meanwhile.

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../lib/navigate.js";
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
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { viewFilterOf, type ViewNode } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";

const READ_DEBOUNCE_MS = 150;
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

type ViewState =
  | { kind: "loading" }
  | { kind: "no-view" }
  | { kind: "not-a-view" }
  | { kind: "wrong-renderer"; title: string; renderer: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; forViewId: string; title: string; viewProjects: string[] | null };

type BeadsProjectsAnswer = Awaited<ReturnType<typeof trpc.beadsProjects.query>>["projects"];
type BoardAnswer = Awaited<ReturnType<typeof trpc.board.query>>;
interface BoardData {
  registry: BeadsProjectsAnswer;
  board: Pick<BoardAnswer, "cards" | "epics" | "omittedClosed" | "truncated">;
}
type LiveState = "connecting" | "live" | "offline";

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
}

export function BoardView({ viewId, projects }: BoardViewProps) {
  const [viewState, setViewState] = useState<ViewState>(viewId === null ? { kind: "no-view" } : { kind: "loading" });
  const [data, setData] = useState<BoardData | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [eventErrors, setEventErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [highlights, setHighlights] = useState<Highlights>(new Map());
  const [live, setLive] = useState<LiveState>("connecting");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [toggledLanes, setToggledLanes] = useState<ReadonlySet<string>>(new Set());
  const [readNonce, setReadNonce] = useState(0);

  useEffect(() => {
    if (viewId === null) {
      setViewState({ kind: "no-view" });
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

  // The live effect (see the header): subscribe first, read in onStarted.
  useEffect(() => {
    if (view === null) return;
    const viewProjects = view.viewProjects;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    async function read() {
      const mine = ++generation;
      const stale = () => disposed || mine !== generation;
      const ids = [...pending];
      try {
        const registry = (await trpc.beadsProjects.query()).projects;
        if (stale()) return;
        const offered = offeredChips(viewProjects, registry.map((p) => p.key));
        const readable = readableProjects(chosenChips(offered, projects));
        const board = readable.length > 0 ? await trpc.board.query({ projects: readable }) : EMPTY_BOARD;
        if (stale()) return;
        for (const id of ids) pending.delete(id);
        setData({ registry, board });
        setReadError(null);
        setEventErrors(new Map());
        if (ids.length > 0) setHighlights((h) => addHighlights(h, ids, Date.now()));
      } catch (err) {
        if (!stale()) setReadError(messageOf(err, "Failed to read the board."));
      }
    }

    function scheduleRead() {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), READ_DEBOUNCE_MS);
    }

    setLive("connecting");
    const subscription = trpc.boardEvents.subscribe(undefined, {
      onStarted: () => {
        if (disposed) return;
        clearTimeout(timer);
        void read();
      },
      onData: (event) => {
        if (disposed) return;
        if (event.kind === "changed") {
          for (const id of event.changedNodeIds) pending.add(id);
          scheduleRead();
        } else {
          setEventErrors((prev) => new Map(prev).set(event.project, event.message));
        }
      },
      onConnectionStateChange: (state) => {
        if (disposed) return;
        setLive(state.state === "pending" ? "live" : state.state === "connecting" ? "connecting" : "offline");
      },
      onError: (err) => {
        if (disposed) return;
        // No stream (e.g. no watcher on this server): the board still reads once, it just does not stay current.
        setLive("offline");
        setReadError(messageOf(err, "The live update stream failed."));
        void read();
      },
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [view?.forViewId, projectsKey, readNonce]);

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
      setReadNonce((n) => n + 1);
    } catch (err) {
      setRefreshNote(messageOf(err, "Refresh failed."));
    } finally {
      setRefreshing(false);
    }
  }

  const offered = view && data ? offeredChips(view.viewProjects, data.registry.map((p) => p.key)) : [];
  const chosen = chosenChips(offered, projects);

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
    if (viewId === null) return;
    navigate({ view: "board", viewId, projects: toggleChip(offered, projects, key) }, "push");
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
    <main className="flex h-dvh w-screen flex-col overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <header className="glass m-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <h1 className="min-w-0 truncate text-base font-semibold text-fg">{heading}</h1>
        {view && offered.length > 0 && (
          <div role="group" aria-label="Projects" className="flex flex-wrap gap-1.5">
            {offered.map((key) => {
              const on = chosen.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleProject(key)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent ${
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
              className="rounded-lg border border-hairline px-3 py-1 font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {viewState.kind === "no-view" && <Empty>No view is named in the address.</Empty>}
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
              <div className="glass min-h-0 flex-1 overflow-auto" aria-label="Board" role="region" tabIndex={0}>
                <div className="min-w-[83rem] p-3">
                  <div className="sticky top-0 z-10 grid grid-cols-[repeat(5,minmax(16rem,1fr))] gap-3 bg-ground/90 pb-2">
                    {BOARD_COLUMN_ORDER.map((col) => (
                      <h2 key={col.id} className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                        {col.label} <span className="font-normal">{cards.filter((c) => c.column === col.id).length}</span>
                      </h2>
                    ))}
                  </div>
                  {lanes.length === 0 && <p className="py-6 text-sm text-fg-muted">No items on this board.</p>}
                  {lanes.map((lane) => (
                    <LaneSection key={lane.epicId ?? "no-epic"} lane={lane} open={lane.collapsedByDefault === toggledLanes.has(lane.epicId ?? "")} onToggle={() => toggleLane(lane)} highlights={highlights} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
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

function LaneSection({ lane, open, onToggle, highlights }: { lane: BoardLane; open: boolean; onToggle: () => void; highlights: Highlights }) {
  return (
    <section aria-label={lane.title} className="border-t border-hairline py-2">
      <h3 className="mb-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex max-w-full items-center gap-2 rounded text-left text-sm font-medium text-fg focus:outline-none focus:ring-2 focus:ring-accent"
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
          {BOARD_COLUMN_ORDER.map((col) => (
            <ul key={col.id} aria-label={`${lane.title}: ${col.label}`} className="min-h-4 space-y-2">
              {lane.columns[col.id].map((card) => (
                <CardItem key={card.id} card={card} highlighted={highlights.has(card.id)} />
              ))}
            </ul>
          ))}
        </div>
      )}
    </section>
  );
}

function CardItem({ card, highlighted }: { card: BoardCardRow; highlighted: boolean }) {
  const href = formatRoute({ view: "graph", q: null, types: [], node: card.id });
  function open(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ view: "graph", q: null, types: [], node: card.id }, "push");
  }
  return (
    <li data-node-id={card.id} data-highlighted={highlighted ? "true" : undefined}>
      <a
        href={href}
        onClick={open}
        className={`block rounded-lg border bg-surface-strong p-2.5 text-left transition-shadow focus:outline-none focus:ring-2 focus:ring-accent ${
          highlighted ? "border-accent ring-2 ring-accent/60" : "border-hairline hover:border-accent/50"
        }`}
      >
        <span className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
          <span className="truncate font-mono">{card.externalId}</span>
          {card.blockedFlag && <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-300">blocked</span>}
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

