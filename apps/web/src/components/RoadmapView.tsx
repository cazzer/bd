// The roadmap view (roadmap-milestones, design.md decisions 6-7; work-roadmap
// spec), mounted by the shell (App.tsx) under `/roadmap?project=<key>&item=<id>`
// (lib/route.ts): each shown project's milestones in due order, each heading
// its epics, then "No milestone", on one shared week-scaled timeline with a
// line at today, and progress rolled up from items. It writes nothing.
//
// Header: laid out as the board's so the switcher and toggle do not move
// between the two (its h1 is for screen readers): the project switcher the
// board uses, offering every registered project (a switch drops the open
// item), live as soon as the registry is read whatever the roadmap read
// does, and with the address's projects and "All projects" when the registry
// cannot be read (lib/workViewNav.ts `switcherOffer`); the Board / Roadmap
// toggle, which carries the projects back to `/board` and drops the item;
// and the review queue's pill, placed here as every view places it.
//
// Sections and groups are lib/roadmapRows.ts; the axis, bars, remaining
// spans, markers, overdue rule, and date labels are lib/roadmapLayout.ts.
// The timeline is plain DOM: each row is a two-column grid, a sticky
// title/progress column and the timeline column, whose week lines are a
// repeating background and whose bars and markers are absolutely positioned
// by fraction of the axis. A bar is the work done (first claim to close, or
// to today); a dashed span is what remains, from today to the target, red
// once the target has passed. Weeks widen to fill the region (never below
// WEEK_MIN_PX), re-fit on resize; past that the region scrolls on its own,
// both ways, with a fade at its right edge while more lies that way, and a
// sticky month label names where the visible timeline starts. A phone-width
// page never scrolls sideways. The axis header and each project's heading
// stick to the top; projects and milestone groups fold (a folded milestone
// keeps its own row), remembered per browser. The timeline is decoration for
// sighted readers; each row's text says the same (dates, status, progress,
// overdue).
//
// The drawer is the board's (ReviewDrawer.tsx), reused as is: activating a
// row pushes its external id as `item`, closing pushes the address without
// it and returns focus to the row. Its project is the row's, or the one
// chosen project before the row is shown (lib/roadmapRows.ts); it re-reads
// after every roadmap read (`version`).
//
// Live: as on the board, one effect registers with the tab's one live
// stream (lib/liveStream.ts) and reads in `onStarted`; a change reported for
// a project the roadmap draws — a shown project, or one owning a shown
// epic's milestone (any project, when every project is shown) — schedules a
// re-read through the board's read scheduler (lib/readScheduler.ts), so a
// burst collapses to one read and reads never overlap. A project switch
// re-reads on the same registration; the previous roadmap stays on screen,
// narrowed to the chosen projects and marked aria-busy, until the answer
// lands, and a project the previous read did not cover reads "Loading…".
// "Today" moves at the reader's local midnight.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { chosenProjects, offeredProjects, readableProjects } from "../lib/boardRow.js";
import { subscribeLive } from "../lib/liveStream.js";
import { navigate } from "../lib/navigate.js";
import { createReadScheduler, READ_DEBOUNCE_MS, READ_MAX_WAIT_MS } from "../lib/readScheduler.js";
import {
  barSpan,
  buildAxis,
  calendarToday,
  dayAt,
  describeProgress,
  epicDates,
  formatMonthYear,
  formatRoadmapDate,
  isOverdue,
  markerAt,
  msUntilLocalMidnight,
  onAxis,
  remainingSpan,
  tickUnderToday,
  todayAt,
  type Axis,
  type ProgressCounts,
  type RowDates,
} from "../lib/roadmapLayout.js";
import { buildRoadmapSections, NO_MILESTONE_TITLE, roadmapItemProject, watchedProjects, type RoadmapEpic, type RoadmapGroup, type RoadmapSection } from "../lib/roadmapRows.js";
import { formatRoute, type RoadmapRoute } from "../lib/route.js";
import { chooseProject, roadmapToBoard, switcherOffer } from "../lib/workViewNav.js";
import { trpc } from "../trpc.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";
import { ReviewQueuePill, storeDraft, useShellDrawer } from "./ReviewQueue.js";
import { WorkViewToggle } from "./WorkViewToggle.js";

type BeadsProjectsAnswer = Awaited<ReturnType<typeof trpc.beadsProjects.query>>["projects"];
type RoadmapAnswer = Awaited<ReturnType<typeof trpc.roadmap.query>>;

interface RoadmapData {
  answer: RoadmapAnswer;
  /** The projects the read asked for; null when it read every registered project. */
  read: readonly string[] | null;
}

/** The narrowest a week gets (2.25rem) before the timeline scrolls instead of fitting. */
const WEEK_MIN_PX = 36;
/** The week width before the region is measured. */
const WEEK_DEFAULT_PX = 56;
const COLLAPSED_KEY = "breakdown.roadmap.collapsed";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Folded projects and groups, remembered per browser; storage may be missing or refuse, and then nothing is remembered. */
function loadCollapsed(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Not remembered; the fold still applies for this visit.
  }
}

export interface RoadmapViewProps {
  projects: string[];
  /** The external id whose drawer is open; null when none is. */
  item: string | null;
}

export function RoadmapView({ projects, item }: RoadmapViewProps) {
  const [registry, setRegistry] = useState<BeadsProjectsAnswer | null>(null);
  const [registryFailed, setRegistryFailed] = useState(false);
  const [data, setData] = useState<RoadmapData | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [eventErrors, setEventErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [reading, setReading] = useState(false);
  const [version, setVersion] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const regionRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<string | null>(null);
  const projectsRef = useRef(projects);
  const appliedKeyRef = useRef(projects.join("\u0000"));
  const readRef = useRef<(() => void) | null>(null);
  /** The projects whose changes re-read the roadmap; null for every project. */
  const watchedRef = useRef<readonly string[] | null>(null);
  const wide = useWideDrawer();
  const { open: shellDrawerOpen, drafts } = useShellDrawer();

  // The live effect (see the header): register with the live stream, read in onStarted.
  useEffect(() => {
    let disposed = false;

    async function readOnce() {
      const address = projectsRef.current;
      let keys: string[] | null = null;
      try {
        const reg = (await trpc.beadsProjects.query()).projects;
        if (disposed) return;
        keys = reg.map((p) => p.key);
        setRegistry(reg);
        setRegistryFailed(false);
      } catch (err) {
        if (disposed) return;
        // Without the registry the roadmap is still read: the address's projects, or every registered one (the server knows them).
        setRegistryFailed(true);
        setReadError(messageOf(err, "Failed to read the projects."));
      }
      let read: string[] | null;
      if (keys !== null) {
        const offered = offeredProjects(null, keys);
        const chosen = chosenProjects(offered, address);
        read = chosen.length === offered.length ? null : readableProjects(chosen);
      } else {
        read = address.length > 0 ? readableProjects(address) : null;
      }
      try {
        const answer: RoadmapAnswer =
          keys !== null && keys.length === 0 ? { milestones: [], epics: [], truncated: false } : await trpc.roadmap.query(read === null ? {} : { projects: read });
        if (disposed) return;
        watchedRef.current = watchedProjects(answer, read);
        setData({ answer, read });
        setVersion((v) => v + 1);
        if (keys !== null) setReadError(null);
        setEventErrors(new Map());
      } catch (err) {
        if (!disposed) setReadError(messageOf(err, "Failed to read the roadmap."));
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
        const watched = watchedRef.current;
        if (event.kind === "changed") {
          if (watched === null || watched.includes(event.project)) scheduler.schedule();
        } else {
          setEventErrors((prev) => new Map(prev).set(event.project, event.message));
        }
      },
      onError: (err) => {
        if (disposed) return;
        // No stream (e.g. no watcher on this server): the roadmap still reads once, it just does not stay current.
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
  }, []);

  // A project switch re-reads on the live registration instead of re-registering.
  const projectsKey = projects.join("\u0000");
  useEffect(() => {
    if (appliedKeyRef.current === projectsKey) return;
    appliedKeyRef.current = projectsKey;
    projectsRef.current = projects;
    readRef.current?.();
  }, [projectsKey]);

  // "Today" moves at the reader's local midnight.
  useEffect(() => {
    const timer = setTimeout(() => setClock(new Date()), msUntilLocalMidnight(clock) + 1000);
    return () => clearTimeout(timer);
  }, [clock]);
  const today = calendarToday(clock);

  const route: RoadmapRoute = { view: "roadmap", projects, item };
  const offered = registry === null ? null : offeredProjects(null, registry.map((p) => p.key));
  const { offered: switcherOffered, fallback: switcherFallback } = switcherOffer({ viewProjects: null, registry: offered, registryFailed, address: projects });

  // The projects to draw, and whether that is every project (then a project with nothing planned is left out).
  const answerProjects = data ? [...new Set([...data.answer.milestones, ...data.answer.epics].map((r) => r.project))] : [];
  const chosen = offered !== null ? chosenProjects(offered, projects) : projects.length > 0 ? projects : answerProjects;
  const chosenKey = chosen.join("\u0000");
  const everyProject = offered !== null ? chosen.length === offered.length : projects.length === 0;
  const sections = useMemo(() => (data ? buildRoadmapSections(data.answer, chosen, everyProject, data.read) : []), [data, chosenKey, everyProject]);

  // A hand-edited or stale address is rewritten to the canonical selection, as on the board.
  const canonicalProjects = offered !== null && chosen.length !== offered.length ? chosen : [];
  const canonicalKey = canonicalProjects.join("\u0000");
  useEffect(() => {
    if (offered === null || offered.length === 0 || canonicalKey === projectsKey) return;
    navigate({ view: "roadmap", projects: canonicalProjects, item }, "replace");
  }, [offered?.length, canonicalKey, projectsKey, item]);

  const errors = new Map<string, string>();
  for (const p of registry ?? []) if (p.lastIngest && !p.lastIngest.ok) errors.set(p.key, p.lastIngest.error);
  for (const [project, message] of eventErrors) errors.set(project, message);
  const shownErrors = [...errors].filter(([project]) => chosen.includes(project));

  const drawerOpen = item !== null;
  const drawerProjectKey = item === null ? null : roadmapItemProject(item, sections, chosen);

  // Focus returns to the row once the drawer is gone, or to the roadmap when the row is not shown.
  useEffect(() => {
    const closed = returnFocusTo.current;
    if (item !== null || closed === null) return;
    returnFocusTo.current = null;
    const link = document.querySelector<HTMLAnchorElement>(`[data-roadmap-row="${CSS.escape(closed)}"] a`);
    (link ?? regionRef.current)?.focus();
  }, [item]);

  function closeDrawer() {
    returnFocusTo.current = item;
    navigate({ ...route, item: null }, "push");
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  const nothingAnywhere = data !== null && data.read === null && everyProject && sections.length === 0 && (offered === null || offered.length > 0);
  const allEmpty = sections.length > 0 && sections.every((s) => !s.loading && s.groups.length === 0);

  return (
    <main className={`flex h-dvh w-screen flex-col overflow-hidden ${drawerOpen || shellDrawerOpen ? "sm:pr-[492px]" : ""}`}>
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <header inert={drawerOpen && !wide} className="glass m-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <h1 className="sr-only">Roadmap</h1>
        {(switcherFallback || switcherOffered?.length !== 0) && (
          <ProjectSwitcher
            offered={switcherOffered}
            address={projects}
            fallback={switcherFallback}
            onChoose={(choice) => switcherOffered && navigate(chooseProject(route, switcherOffered, choice), "push")}
          />
        )}
        <WorkViewToggle current="roadmap" board={roadmapToBoard(route)} roadmap={route} />
        <div className="ml-auto flex items-center text-xs text-fg-muted">
          <ReviewQueuePill />
        </div>
      </header>

      <div inert={drawerOpen && !wide} className="flex min-h-0 flex-1 flex-col gap-3 p-3">
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
        {data?.answer.truncated && (
          <p role="status" className="text-xs text-fg-muted">
            The roadmap is too large to show in full: only the first milestones and epics are drawn.
          </p>
        )}
        {!data && !readError && <Empty>Loading…</Empty>}
        {offered !== null && offered.length === 0 && <Empty>No beads project is registered. Load one with pnpm ingest:beads.</Empty>}
        {nothingAnywhere && (
          <Empty>
            <NothingPlanned where="any project" />
          </Empty>
        )}
        {allEmpty && (
          <Empty>
            <NothingPlanned where={sections.map((s) => s.project).join(" or ")} />
          </Empty>
        )}
        {data && sections.length > 0 && !allEmpty && (
          <Timeline
            regionRef={regionRef}
            sections={sections}
            today={today}
            route={route}
            selected={item}
            reading={reading}
            collapsed={collapsed}
            onToggle={toggle}
          />
        )}
      </div>
      {drawerOpen && item !== null && (
        <ReviewDrawer
          key={item}
          project={drawerProjectKey}
          item={item}
          boardLoaded={data !== null}
          boardVersion={version}
          initialDraft={drafts.get(item) ?? ""}
          onDraftChange={(draft) => storeDraft(drafts, item, draft)}
          onDecided={() => {}}
          onProjectConfirmed={() => {}}
          onClose={closeDrawer}
        />
      )}
    </main>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="glass p-4 text-sm text-fg-muted">{children}</p>;
}

function NothingPlanned({ where }: { where: string }) {
  return (
    <>
      No milestones or epics in {where} yet. Create a milestone with <code className="font-mono whitespace-nowrap text-fg">bd create -t milestone --due …</code> and put epics
      under it with <code className="font-mono whitespace-nowrap text-fg">bd create -t epic --parent &lt;milestone&gt;</code>.
    </>
  );
}

/** Every date a row puts on the axis. */
function axisDates(sections: readonly RoadmapSection[]): RowDates[] {
  const rows: RowDates[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      if (group.head.kind !== "none") rows.push({ start: null, end: null, target: group.head.milestone.dueAt });
      for (const epic of group.epics) rows.push(epicDates(epic));
    }
  }
  return rows;
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

/** What every row needs to place itself on the shared axis. */
interface Geometry {
  axis: Axis;
  today: number;
  /** The instant of this render, for bar clamping (roadmapLayout.ts `barSpan`). */
  now: number;
  todayFraction: number;
  weekPx: number;
}

interface TimelineProps {
  regionRef: RefObject<HTMLDivElement | null>;
  sections: readonly RoadmapSection[];
  today: number;
  route: RoadmapRoute;
  selected: string | null;
  reading: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

function Timeline({ regionRef, sections, today, route, selected, reading, collapsed, onToggle }: TimelineProps) {
  const axis = useMemo(() => buildAxis(axisDates(sections), today), [sections, today]);
  const titlesRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ region: 0, titles: 0 });
  const [scroll, setScroll] = useState({ left: 0, more: false });

  // The region's and the title column's widths, measured before paint and on every resize, fit the weeks to the space.
  useLayoutEffect(() => {
    const region = regionRef.current;
    const titles = titlesRef.current;
    if (!region || !titles) return;
    const measure = () => setSize({ region: region.clientWidth, titles: titles.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(titles);
    return () => observer.disconnect();
  }, [regionRef]);

  const available = size.region - size.titles;
  const weekPx = size.region === 0 ? WEEK_DEFAULT_PX : Math.max(WEEK_MIN_PX, Math.floor((available / axis.weeks) * 100) / 100);
  const timelinePx = axis.weeks * weekPx;
  const geo: Geometry = { axis, today, now: Date.now(), todayFraction: todayAt(axis, today), weekPx };

  function readScroll() {
    const region = regionRef.current;
    if (!region) return;
    setScroll({ left: region.scrollLeft, more: region.scrollLeft + region.clientWidth < region.scrollWidth - 1 });
  }
  useLayoutEffect(readScroll, [timelinePx, size.region]);

  // Once measured, the today line is brought into view (a third of the way
  // across the visible timeline) when it starts off to the right, as it does
  // at phone width; later reads and resizes leave the reader's scroll alone.
  const scrolledToToday = useRef(false);
  useLayoutEffect(() => {
    if (scrolledToToday.current || size.region === 0) return;
    scrolledToToday.current = true;
    const region = regionRef.current;
    if (!region) return;
    const lineX = size.titles + geo.todayFraction * timelinePx;
    if (lineX < region.clientWidth - 48) return;
    region.scrollLeft = Math.max(0, lineX - size.titles - available / 3);
    readScroll();
  }, [size.region]);

  const visibleStartDay = dayAt(axis, Math.min(1, scroll.left / timelinePx));

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={regionRef}
        onScroll={readScroll}
        className="glass h-full overflow-auto [--axis-h:2.75rem] [--left:9.5rem] sm:[--left:21rem]"
        aria-label="Roadmap"
        role="region"
        tabIndex={0}
        aria-busy={reading}
      >
        {reading && <div aria-hidden="true" className="sticky top-0 left-0 z-50 h-0.5 w-full animate-pulse bg-accent" />}
        <div style={{ width: `calc(var(--left) + ${timelinePx}px)` }}>
          <AxisHeader geo={geo} titlesRef={titlesRef} stickyMonth={scroll.left > 4 ? formatMonthYear(visibleStartDay) : null} />
          {sections.map((section) => (
            <ProjectSection key={section.project} section={section} geo={geo} route={route} selected={selected} collapsed={collapsed} onToggle={onToggle} />
          ))}
        </div>
      </div>
      {scroll.more && <div aria-hidden="true" className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-2xl bg-gradient-to-l from-ground to-transparent" />}
    </div>
  );
}

function AxisHeader({ geo, titlesRef, stickyMonth }: { geo: Geometry; titlesRef: RefObject<HTMLDivElement | null>; stickyMonth: string | null }) {
  const { axis, today, todayFraction, weekPx } = geo;
  return (
    <div className="sticky top-0 z-30 grid h-[var(--axis-h)] grid-cols-[var(--left)_minmax(0,1fr)] border-b border-hairline bg-ground">
      <div ref={titlesRef} className="sticky left-0 z-40 flex flex-col justify-center gap-0.5 bg-ground px-3 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-fg-muted">Milestones & epics</span>
        <span aria-hidden="true" className="hidden items-center gap-2.5 text-fg-muted sm:flex">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-full border border-accent/70 bg-accent/40" />
            worked
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-r-full border border-dashed border-accent/60" />
            remaining
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-0.5 rounded-full bg-fg" />
            target
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rotate-45 border border-accent bg-accent/80" />
            milestone
          </span>
        </span>
      </div>
      <div aria-hidden="true" className="relative text-[11px] text-fg-muted">
        {axis.ticks.map((tick) => (
          <span key={tick.day} className="absolute inset-y-0 pl-1" style={{ left: pct(tick.at) }}>
            <span className="block h-5 pt-1 leading-4 font-medium whitespace-nowrap text-fg">{tick.monthLabel ?? ""}</span>
            <span className="block leading-4">{tickUnderToday(tick.day, today, weekPx / 7) ? "" : new Date(tick.day).getUTCDate()}</span>
          </span>
        ))}
        {stickyMonth !== null && <span className="sticky left-[var(--left)] z-10 inline-block bg-ground pt-1 pr-2 pl-1 leading-4 font-medium text-fg">{stickyMonth}</span>}
        <span className="absolute bottom-1 -translate-x-1/2 rounded-full bg-accent px-1.5 text-[10px] leading-4 font-medium text-ground" style={{ left: pct(todayFraction) }}>
          Today
        </span>
      </div>
      <span className="sr-only">Today is {formatRoadmapDate(new Date(today).toISOString(), today)}.</span>
    </div>
  );
}

interface SectionProps {
  section: RoadmapSection;
  geo: Geometry;
  route: RoadmapRoute;
  selected: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

function ProjectSection({ section, geo, route, selected, collapsed, onToggle }: SectionProps) {
  const headingId = `roadmap-${section.project}`;
  const listId = `${headingId}-groups`;
  const folded = collapsed.has(`project:${section.project}`);
  const milestones = section.groups.filter((g) => g.head.kind !== "none").length;
  const epics = section.groups.reduce((n, g) => n + g.epics.length, 0);
  return (
    <section aria-labelledby={headingId}>
      <div className="sticky top-[var(--axis-h)] z-[25] border-b border-hairline bg-ground">
        <h2 id={headingId} className="sticky left-0 flex w-max max-w-[calc(100vw-3rem)] items-center gap-3 px-3 py-1.5 text-xs">
          <button
            type="button"
            aria-expanded={!folded}
            aria-controls={listId}
            onClick={() => onToggle(`project:${section.project}`)}
            className="flex min-h-11 items-center gap-1.5 rounded font-mono font-semibold text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-0"
          >
            <Chevron open={!folded} />
            {section.project}
          </button>
          {folded && !section.loading && (
            <span className="flex gap-2 text-fg-muted">
              <span>{milestones === 1 ? "1 milestone" : `${milestones} milestones`}</span>
              <span>{epics === 1 ? "1 epic" : `${epics} epics`}</span>
            </span>
          )}
        </h2>
      </div>
      {!folded &&
        (section.loading ? (
          <p className="sticky left-0 w-[var(--left)] bg-ground px-3 py-3 text-sm text-fg-muted">Loading…</p>
        ) : section.groups.length === 0 ? (
          <p className="sticky left-0 w-max max-w-[calc(100vw-3rem)] bg-ground px-3 py-3 text-sm text-fg-muted">No milestones or epics in {section.project} yet.</p>
        ) : (
          <ul id={listId} role="list" aria-label={`${section.project} milestones`}>
            {section.groups.map((group) => (
              <GroupItem key={group.key} project={section.project} group={group} geo={geo} route={route} selected={selected} collapsed={collapsed} onToggle={onToggle} />
            ))}
          </ul>
        ))}
    </section>
  );
}

function groupTitle(group: RoadmapGroup): string {
  return group.head.kind === "none" ? NO_MILESTONE_TITLE : group.head.milestone.title || "(untitled)";
}

function GroupItem({ project, group, geo, route, selected, collapsed, onToggle }: Omit<SectionProps, "section"> & { project: string; group: RoadmapGroup }) {
  const key = `group:${project}:${group.key}`;
  const folded = collapsed.has(key);
  const title = groupTitle(group);
  const listId = `roadmap-${project}-${group.key}-epics`;
  const fold = group.epics.length > 0 ? { open: !folded, controls: listId, label: `${title}: epics`, onToggle: () => onToggle(key) } : null;
  return (
    <li className="border-b border-hairline last:border-b-0">
      {group.head.kind === "none" ? (
        <div className="grid grid-cols-[var(--left)_minmax(0,1fr)]">
          <h3 className="sticky left-0 z-20 bg-ground px-3 pt-2 pb-1 text-sm font-medium text-fg-muted">
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={listId}
              onClick={() => onToggle(key)}
              className="flex min-h-11 items-center gap-1.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-0"
            >
              <Chevron open={!folded} />
              {NO_MILESTONE_TITLE}
            </button>
          </h3>
          <TimelineCell geo={geo} />
        </div>
      ) : (
        <MilestoneRow head={group.head} geo={geo} route={route} selected={selected} fold={fold} />
      )}
      {group.epics.length > 0 && !folded && (
        <ul id={listId} role="list" aria-label={`${title}: epics`}>
          {group.epics.map((epic) => (
            <EpicRow key={epic.id} epic={epic} geo={geo} route={route} selected={selected === epic.externalId} />
          ))}
        </ul>
      )}
    </li>
  );
}

interface Fold {
  open: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
}

function MilestoneRow({
  head,
  geo,
  route,
  selected,
  fold,
}: {
  head: Extract<RoadmapGroup["head"], { kind: "milestone" | "foreign" }>;
  geo: Geometry;
  route: RoadmapRoute;
  selected: string | null;
  fold: Fold | null;
}) {
  const m = head.milestone;
  const due = formatRoadmapDate(m.dueAt, geo.today);
  const overdue = isOverdue(m.status, m.dueAt, geo.today);
  const closed = m.status === "closed";
  const foreign = head.kind === "foreign";
  const opens = m.project !== null;
  return (
    <RowFrame
      externalId={m.externalId}
      route={route}
      selected={opens && selected === m.externalId}
      overdue={overdue}
      linked={opens}
      heading
      fold={fold}
      left={
        <>
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span aria-hidden="true" className={`shrink-0 text-xs ${overdue ? "text-red-300" : closed ? "text-fg-muted" : "text-accent"}`}>
              ◇
            </span>
            <span className="sr-only">Milestone: </span>
            <span className={`line-clamp-2 min-w-0 font-medium [overflow-wrap:anywhere] ${closed ? "text-fg-muted" : "text-fg"}`}>{m.title || "(untitled)"}</span>
          </span>
          <DetailLine>
            {head.kind === "milestone" && <ProgressCluster progress={head.milestone.progress} />}
            <StatusPill status={m.status} />
            {overdue && <OverduePill />}
            <span>{due ? `Due ${due}` : "No due date"}</span>
            {foreign && <span>milestone of {m.project ?? "another project"}</span>}
            {head.kind === "milestone" && head.milestone.unepicked.total > 0 && <span>+{head.milestone.unepicked.total} not in an epic</span>}
          </DetailLine>
        </>
      }
      timeline={<MilestoneMarker dueAt={m.dueAt} geo={geo} overdue={overdue} closed={closed} />}
      geo={geo}
    />
  );
}

function EpicRow({ epic, geo, route, selected }: { epic: RoadmapEpic; geo: Geometry; route: RoadmapRoute; selected: boolean }) {
  const { axis, today, now } = geo;
  const dates = epicDates(epic);
  const overdue = isOverdue(epic.status, dates.target, today);
  const closed = epic.status === "closed";
  const bar = barSpan(axis, dates, today, now);
  const remaining = remainingSpan(axis, epic.status, dates.target, today);
  const target = markerAt(axis, dates.target);
  const started = formatRoadmapDate(dates.start, today);
  const targetText = formatRoadmapDate(dates.target, today);
  const closedText = formatRoadmapDate(dates.end, today);
  const targetTitle = targetText === null ? undefined : dates.targetFromMilestone ? `Milestone due ${targetText}` : `Target ${targetText}`;
  return (
    <li>
      <RowFrame
        externalId={epic.externalId}
        route={route}
        selected={selected}
        overdue={overdue}
        linked
        indent
        geo={geo}
        left={
          <>
            <span className="sr-only">Epic: </span>
            <span className={`line-clamp-2 min-w-0 [overflow-wrap:anywhere] ${closed ? "text-fg-muted" : "text-fg"}`}>{epic.title || "(untitled)"}</span>
            <DetailLine>
              <ProgressCluster progress={epic.progress} />
              <StatusPill status={epic.status} />
              {overdue && <OverduePill />}
              <span>
                {started ? `Started ${started}` : "Not started"}
                {closedText ? `, closed ${closedText}` : ""}
              </span>
              {targetTitle && <span>{targetTitle}</span>}
            </DetailLine>
          </>
        }
        timeline={
          <>
            {bar && (
              <span
                data-epic-bar
                className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-full border ${closed ? "border-fg-muted/40 bg-fg-muted/25" : "border-accent/70 bg-accent/40"} ${
                  remaining && !remaining.overdue && bar.running ? "rounded-r-none" : ""
                }`}
                style={{ left: pct(bar.from), width: pct(bar.to - bar.from) }}
              />
            )}
            {remaining && onAxis(remaining.from) && (
              <span
                data-remaining={remaining.overdue ? "overdue" : "ahead"}
                className={`absolute top-1/2 h-3 -translate-y-1/2 border border-dashed ${
                  remaining.overdue ? "rounded-full border-red-400/80 bg-red-500/25" : `rounded-r-full border-accent/60 ${bar?.running ? "border-l-0" : "rounded-l-full"}`
                }`}
                style={{ left: pct(remaining.from), width: pct(Math.min(1, remaining.to) - remaining.from) }}
              />
            )}
            {target !== null && onAxis(target) && (
              <span data-target-marker title={targetTitle} className="absolute top-1/2 flex -translate-y-1/2 items-center" style={{ left: pct(target) }}>
                <span className={`block h-5 w-0.5 -translate-x-1/2 rounded-full ${overdue ? "bg-red-400" : dates.targetFromMilestone ? "bg-fg-muted/60" : "bg-fg"}`} />
                {!dates.targetFromMilestone && (
                  <span className={`ml-0.5 rounded bg-ground px-1 text-[10px] whitespace-nowrap ${overdue ? "text-red-300" : "text-fg-muted"}`}>{targetText}</span>
                )}
              </span>
            )}
          </>
        }
      />
    </li>
  );
}

function RowFrame({
  externalId,
  route,
  selected,
  overdue,
  linked,
  indent = false,
  heading = false,
  fold = null,
  left,
  timeline,
  geo,
}: {
  externalId: string;
  route: RoadmapRoute;
  selected: boolean;
  overdue: boolean;
  linked: boolean;
  indent?: boolean;
  /** A group's milestone row: its title column is the group's heading. */
  heading?: boolean;
  /** The group's fold toggle, on a milestone row whose group has epics. */
  fold?: Fold | null;
  left: ReactNode;
  timeline: ReactNode;
  geo: Geometry;
}) {
  const target: RoadmapRoute | null = linked ? { ...route, item: externalId } : null;
  function open(e: MouseEvent<HTMLElement>) {
    if (target === null || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(target, "push");
  }
  const cell = `block min-w-0 flex-1 py-1.5 pr-3 text-sm ${indent ? "pl-4" : "pl-0"}`;
  return (
    <div data-roadmap-row={externalId} data-overdue={overdue ? "true" : undefined} className={`group grid grid-cols-[var(--left)_minmax(0,1fr)] ${selected ? "bg-accent/10" : ""}`}>
      <div
        role={heading ? "heading" : undefined}
        aria-level={heading ? 3 : undefined}
        className={`sticky left-0 z-20 flex items-start border-l-2 bg-ground ${selected ? "border-accent" : overdue ? "border-red-400/70" : "border-transparent"}`}
      >
        {fold ? (
          <button
            type="button"
            aria-expanded={fold.open}
            aria-controls={fold.controls}
            aria-label={fold.label}
            onClick={fold.onToggle}
            className="mt-1 flex h-11 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-6"
          >
            <Chevron open={fold.open} />
          </button>
        ) : (
          <span aria-hidden="true" className="w-7 shrink-0" />
        )}
        {target !== null ? (
          <a
            href={formatRoute(target)}
            onClick={open}
            aria-current={selected ? "true" : undefined}
            className={`${cell} rounded-md hover:bg-surface-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${selected ? "bg-accent/10" : ""}`}
          >
            {left}
          </a>
        ) : (
          <div className={cell}>{left}</div>
        )}
      </div>
      <TimelineCell geo={geo} onClick={target !== null ? open : undefined}>
        {timeline}
      </TimelineCell>
    </div>
  );
}

/** A row's timeline column: week lines (a repeating background, so they never pass under the title column), the today line, and the row's marks. */
function TimelineCell({ geo, onClick, children }: { geo: Geometry; onClick?: (e: MouseEvent<HTMLElement>) => void; children?: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      onClick={onClick}
      className={`relative min-h-11 ${onClick ? "cursor-pointer group-hover:bg-surface-strong/40" : ""}`}
      style={{ backgroundImage: "linear-gradient(to right, var(--color-hairline) 1px, transparent 1px)", backgroundSize: `${geo.weekPx}px 100%` }}
    >
      <span data-today-line className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent/70" style={{ left: pct(geo.todayFraction) }} />
      {children}
    </div>
  );
}

function MilestoneMarker({ dueAt, geo, overdue, closed }: { dueAt: string | null; geo: Geometry; overdue: boolean; closed: boolean }) {
  const at = markerAt(geo.axis, dueAt);
  if (at === null || !onAxis(at)) return null;
  const tone = overdue ? "border-red-300 bg-red-400" : closed ? "border-fg-muted bg-fg-muted/40" : "border-accent bg-accent/80";
  return (
    <span data-milestone-marker className="absolute top-1/2 flex -translate-y-1/2 items-center" style={{ left: pct(at) }}>
      <span className={`block h-3 w-3 -translate-x-1/2 rotate-45 border ${tone}`} />
      <span className={`ml-0.5 rounded bg-ground px-1 text-[11px] whitespace-nowrap ${overdue ? "text-red-300" : "text-fg-muted"}`}>{formatRoadmapDate(dueAt, geo.today)}</span>
    </span>
  );
}

function DetailLine({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">{children}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}>
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-normal text-fg-muted">{status.replace(/_/g, " ")}</span>;
}

function OverduePill() {
  return <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-normal text-red-300">overdue</span>;
}

function ProgressCluster({ progress }: { progress: ProgressCounts }) {
  const reading = describeProgress(progress);
  if (reading.kind !== "share") return <span data-progress={reading.kind}>{reading.text}</span>;
  return (
    <span data-progress={reading.text} className="inline-flex flex-wrap items-center gap-x-1.5 whitespace-nowrap">
      <span aria-hidden="true" className="inline-block h-1.5 w-10 overflow-hidden rounded-full bg-fg-muted/20">
        <span className="block h-full bg-accent" style={{ width: pct(reading.share) }} />
      </span>
      <span className="text-fg">
        {reading.text}
        <span className="sr-only"> closed</span>
      </span>
      {reading.inProgress > 0 && <span>{reading.inProgress} in progress</span>}
      {reading.deferred > 0 && <span>{reading.deferred} deferred</span>}
    </span>
  );
}
