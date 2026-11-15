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
// cannot be read (ProjectSwitcher's `fallback`); the Board / Roadmap toggle,
// which carries the projects back to `/board` and drops the item; and the
// review queue's pill, placed here as every view places it.
//
// Sections and groups are lib/roadmapRows.ts; the axis, bars, markers,
// overdue rule, and date labels are lib/roadmapLayout.ts. The timeline is
// plain DOM: each row is a two-column grid (a sticky title/progress column
// and the timeline column, with bars absolutely positioned by fraction of
// the axis), and one overlay behind every row draws the week lines and the
// today line. The region scrolls on its own, both ways, so a phone-width page
// never scrolls sideways. The timeline is decoration for sighted readers;
// each row's text says the same (dates, status, progress, overdue).
//
// The drawer is the board's (ReviewDrawer.tsx), reused as is: activating a
// row pushes its external id as `item`, closing pushes the address without
// it and returns focus to the row. Its project is the row's, or the one
// chosen project before the row is shown (lib/roadmapRows.ts); it re-reads
// after every roadmap read (`version`).
//
// Live: as on the board, one effect registers with the tab's one live
// stream (lib/liveStream.ts) and reads in `onStarted`; a change reported for
// a shown project (any project, when every project is shown) schedules a
// re-read through the board's read scheduler (lib/readScheduler.ts), so a
// burst collapses to one read and reads never overlap. A project switch
// re-reads on the same registration; the previous roadmap stays on screen,
// narrowed to the chosen projects and marked aria-busy, until the answer
// lands, and a section the previous read did not cover reads "Loading…"
// rather than empty.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { chosenProjects, offeredProjects, readableProjects } from "../lib/boardRow.js";
import { subscribeLive } from "../lib/liveStream.js";
import { navigate } from "../lib/navigate.js";
import { createReadScheduler, READ_DEBOUNCE_MS, READ_MAX_WAIT_MS } from "../lib/readScheduler.js";
import {
  barSpan,
  buildAxis,
  calendarToday,
  epicDates,
  formatRoadmapDate,
  formatShare,
  isOverdue,
  markerAt,
  progressShare,
  todayAt,
  type Axis,
  type ProgressCounts,
  type RowDates,
} from "../lib/roadmapLayout.js";
import {
  buildRoadmapSections,
  NO_MILESTONE_TITLE,
  roadmapItemProject,
  unreturnedMilestoneIds,
  type ElsewhereMilestone,
  type RoadmapEpic,
  type RoadmapGroup,
  type RoadmapGroupHead,
  type RoadmapSection,
} from "../lib/roadmapRows.js";
import { formatRoute, type RoadmapRoute } from "../lib/route.js";
import { chooseProject, roadmapToBoard } from "../lib/workViewNav.js";
import { trpc } from "../trpc.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ReviewDrawer, useWideDrawer } from "./ReviewDrawer.js";
import { ReviewQueuePill, storeDraft, useShellDrawer } from "./ReviewQueue.js";
import { WorkViewToggle } from "./WorkViewToggle.js";

type BeadsProjectsAnswer = Awaited<ReturnType<typeof trpc.beadsProjects.query>>["projects"];
type RoadmapAnswer = Awaited<ReturnType<typeof trpc.roadmap.query>>;

interface RoadmapData {
  answer: RoadmapAnswer;
  /** Labels for milestones the answer names but does not return (lib/roadmapRows.ts). */
  elsewhere: ReadonlyMap<string, ElsewhereMilestone>;
  /** The projects the read asked for; null when it read every registered project. */
  read: readonly string[] | null;
}

/** One week's width on the axis. */
const WEEK_REM = 3.5;
const CREATE_HINT = "bd create -t milestone --due …";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
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
      watchedRef.current = read;
      try {
        const answer: RoadmapAnswer =
          keys !== null && keys.length === 0 ? { milestones: [], epics: [], truncated: false } : await trpc.roadmap.query(read === null ? {} : { projects: read });
        const elsewhere = new Map<string, ElsewhereMilestone>();
        const unreturned = unreturnedMilestoneIds(answer);
        if (unreturned.length > 0) {
          try {
            for (const node of (await trpc.getNodes.query({ ids: unreturned })).nodes) {
              const project = (node.metadata as Record<string, unknown>)["project"];
              if (typeof project === "string") elsewhere.set(node.id, { externalId: node.externalId, project });
            }
          } catch (err) {
            // Only labels are lost: those headers read "another project" and do not open a drawer.
            console.warn("roadmap: could not look up milestones of projects not shown", err);
          }
        }
        if (disposed) return;
        setData({ answer, elsewhere, read });
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

  const route: RoadmapRoute = { view: "roadmap", projects, item };
  const offered = registry === null ? null : offeredProjects(null, registry.map((p) => p.key));
  const switcherFallback = offered === null && registryFailed;
  const switcherOffered = switcherFallback ? [...projects] : offered;

  // The projects to draw, and whether that is every project (then a project with nothing planned is left out).
  const answerProjects = data ? [...new Set([...data.answer.milestones, ...data.answer.epics].map((r) => r.project))] : [];
  const chosen = offered !== null ? chosenProjects(offered, projects) : projects.length > 0 ? projects : answerProjects;
  const everyProject = offered !== null ? chosen.length === offered.length : projects.length === 0;
  const sections = data ? buildRoadmapSections(data.answer, chosen, everyProject, data.elsewhere) : [];

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

  const today = calendarToday(new Date());
  const covers = (project: string) => data !== null && (data.read === null || data.read.includes(project));

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
        {data && sections.length === 0 && everyProject && (offered === null || offered.length > 0) && (
          <Empty>
            No milestones or epics in any project yet — create one with <code className="font-mono text-fg">{CREATE_HINT}</code>
          </Empty>
        )}
        {data && sections.length > 0 && (
          <Timeline
            regionRef={regionRef}
            sections={sections}
            today={today}
            route={route}
            selected={item}
            reading={reading}
            covers={covers}
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

/** Every date a row puts on the axis. */
function axisDates(sections: readonly RoadmapSection[]): RowDates[] {
  const rows: RowDates[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      if (group.head.kind === "milestone") rows.push({ start: null, end: null, target: group.head.milestone.dueAt });
      if (group.head.kind === "foreign") rows.push({ start: null, end: null, target: group.head.dueAt });
      for (const epic of group.epics) rows.push(epicDates(epic));
    }
  }
  return rows;
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

interface TimelineProps {
  regionRef: RefObject<HTMLDivElement | null>;
  sections: readonly RoadmapSection[];
  today: number;
  route: RoadmapRoute;
  selected: string | null;
  reading: boolean;
  covers: (project: string) => boolean;
}

function Timeline({ regionRef, sections, today, route, selected, reading, covers }: TimelineProps) {
  const axis = buildAxis(axisDates(sections), today);
  const todayFraction = todayAt(axis, today);

  // Once drawn, the today line is brought into view (a third of the way
  // across the visible timeline) when it starts off to the right, as it
  // does at phone width; later reads leave the reader's scroll alone.
  const scrolled = useRef(false);
  useEffect(() => {
    const region = regionRef.current;
    const line = region?.querySelector<HTMLElement>("[data-today-line]");
    const titles = region?.querySelector<HTMLElement>("[data-roadmap-titles]");
    if (scrolled.current || !region || !line || !titles) return;
    scrolled.current = true;
    const lineX = line.getBoundingClientRect().left - region.getBoundingClientRect().left + region.scrollLeft;
    if (lineX < region.clientWidth - 48) return;
    const visible = region.clientWidth - titles.offsetWidth;
    region.scrollLeft = Math.max(0, lineX - titles.offsetWidth - visible / 3);
  });
  return (
    <div ref={regionRef} className="glass relative min-h-0 flex-1 overflow-auto" aria-label="Roadmap" role="region" tabIndex={0} aria-busy={reading}>
      {reading && <div aria-hidden="true" className="sticky top-0 left-0 z-50 h-0.5 w-full animate-pulse bg-accent" />}
      <div className="relative pb-3 [--left:12rem] sm:[--left:21rem]" style={{ minWidth: `calc(var(--left) + ${axis.weeks * WEEK_REM}rem)` }}>
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 left-[var(--left)]">
          {axis.ticks.map((tick) => (
            <span key={tick.day} className={`absolute inset-y-0 w-px ${tick.monthLabel !== null ? "bg-fg-muted/25" : "bg-hairline"}`} style={{ left: pct(tick.at) }} />
          ))}
          <span data-today-line className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent/80" style={{ left: pct(todayFraction) }} />
        </div>
        <AxisHeader axis={axis} today={today} todayFraction={todayFraction} />
        {sections.map((section) => (
          <ProjectSection key={section.project} section={section} axis={axis} today={today} route={route} selected={selected} loading={!covers(section.project)} />
        ))}
      </div>
    </div>
  );
}

function AxisHeader({ axis, today, todayFraction }: { axis: Axis; today: number; todayFraction: number }) {
  return (
    <div className="sticky top-0 z-30 grid grid-cols-[var(--left)_minmax(0,1fr)] border-b border-hairline bg-ground">
      <div data-roadmap-titles className="sticky left-0 z-40 bg-ground px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Milestones & epics</div>
      <div aria-hidden="true" className="relative h-10 text-[11px] text-fg-muted">
        {axis.ticks.map((tick) => (
          <span key={tick.day} className="absolute inset-y-0 pl-1" style={{ left: pct(tick.at) }}>
            <span className="block h-5 leading-5 font-medium whitespace-nowrap text-fg">{tick.monthLabel ?? ""}</span>
            <span className="block leading-4">{new Date(tick.day).getUTCDate()}</span>
          </span>
        ))}
        <span className="absolute bottom-0.5 -translate-x-1/2 rounded-full bg-accent px-1.5 text-[10px] leading-4 font-medium text-ground" style={{ left: pct(todayFraction) }}>
          Today
        </span>
      </div>
      <span className="sr-only">Today is {formatRoadmapDate(new Date(today).toISOString(), today)}.</span>
    </div>
  );
}

function ProjectSection({
  section,
  axis,
  today,
  route,
  selected,
  loading,
}: {
  section: RoadmapSection;
  axis: Axis;
  today: number;
  route: RoadmapRoute;
  selected: string | null;
  loading: boolean;
}) {
  const headingId = `roadmap-${section.project}`;
  return (
    <section aria-labelledby={headingId} className="border-t border-hairline first-of-type:border-t-0">
      <div className="grid grid-cols-[var(--left)_minmax(0,1fr)]">
        <h2 id={headingId} className="sticky left-0 z-20 truncate bg-ground px-3 pt-3 pb-1 font-mono text-xs font-semibold text-fg-muted">
          {section.project}
        </h2>
      </div>
      {section.groups.length === 0 ? (
        <p className="sticky left-0 max-w-[calc(100vw-3rem)] px-3 py-3 text-sm text-fg-muted sm:max-w-xl">
          {loading ? (
            "Loading…"
          ) : (
            <>
              No milestones or epics in {section.project} yet — create one with <code className="font-mono text-fg">{CREATE_HINT}</code>
            </>
          )}
        </p>
      ) : (
        <ul role="list" aria-label={`${section.project} milestones`}>
          {section.groups.map((group) => (
            <GroupItem key={group.key} group={group} axis={axis} today={today} route={route} selected={selected} />
          ))}
        </ul>
      )}
    </section>
  );
}

function headTitle(head: RoadmapGroupHead): string {
  if (head.kind === "milestone") return head.milestone.title || "(untitled)";
  if (head.kind === "foreign") return head.title || "(untitled)";
  return NO_MILESTONE_TITLE;
}

function GroupItem({ group, axis, today, route, selected }: { group: RoadmapGroup; axis: Axis; today: number; route: RoadmapRoute; selected: string | null }) {
  const title = headTitle(group.head);
  return (
    <li className="pb-1">
      <GroupHeadRow head={group.head} axis={axis} today={today} route={route} selected={selected} />
      {group.epics.length > 0 && (
        <ul role="list" aria-label={`${title}: epics`}>
          {group.epics.map((epic) => (
            <EpicRow key={epic.id} epic={epic} axis={axis} today={today} route={route} selected={selected === epic.externalId} />
          ))}
        </ul>
      )}
    </li>
  );
}

function GroupHeadRow({ head, axis, today, route, selected }: { head: RoadmapGroupHead; axis: Axis; today: number; route: RoadmapRoute; selected: string | null }) {
  if (head.kind === "none") {
    return (
      <div className="grid grid-cols-[var(--left)_minmax(0,1fr)]">
        <h3 className="sticky left-0 z-20 bg-ground px-3 pt-2 pb-1 text-sm font-medium text-fg-muted">{NO_MILESTONE_TITLE}</h3>
      </div>
    );
  }
  if (head.kind === "foreign") {
    const due = formatRoadmapDate(head.dueAt, today);
    // Its status is known only when the answer returns it (its project is shown too).
    const overdue = head.milestone !== null && isOverdue(head.milestone.status, head.dueAt, today);
    const body = (
      <>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Diamond overdue={overdue} />
          <span className="line-clamp-2 min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{head.title || "(untitled)"}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-muted">
          <span>milestone in {head.project ?? "another project"}</span>
          <span>{due ? `Due ${due}` : "No due date"}</span>
        </span>
      </>
    );
    const opensDrawer = head.externalId !== null && head.project !== null;
    return (
      <RowFrame
        externalId={head.externalId}
        route={route}
        selected={opensDrawer && selected === head.externalId}
        overdue={overdue}
        heading
        left={body}
        linked={opensDrawer}
        timeline={<MilestoneMarker dueAt={head.dueAt} axis={axis} today={today} overdue={overdue} />}
      />
    );
  }
  const m = head.milestone;
  const due = formatRoadmapDate(m.dueAt, today);
  const overdue = isOverdue(m.status, m.dueAt, today);
  return (
    <RowFrame
      externalId={m.externalId}
      route={route}
      selected={selected === m.externalId}
      overdue={overdue}
      linked
      heading
      left={
        <>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Diamond overdue={overdue} />
            <span className="line-clamp-2 min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{m.title || "(untitled)"}</span>
            <StatusPill status={m.status} />
            {overdue && <OverduePill />}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
            <span>{due ? `Due ${due}` : "No due date"}</span>
            <ProgressSummary progress={m.progress} />
            {m.unepicked.total > 0 && <span>{m.unepicked.total} outside epics</span>}
          </span>
        </>
      }
      timeline={<MilestoneMarker dueAt={m.dueAt} axis={axis} today={today} overdue={overdue} />}
    />
  );
}

function EpicRow({ epic, axis, today, route, selected }: { epic: RoadmapEpic; axis: Axis; today: number; route: RoadmapRoute; selected: boolean }) {
  const dates = epicDates(epic);
  const overdue = isOverdue(epic.status, dates.target, today);
  const bar = barSpan(axis, dates, today);
  const target = markerAt(axis, dates.target);
  const share = progressShare(epic.progress);
  const started = formatRoadmapDate(dates.start, today);
  const targetText = formatRoadmapDate(dates.target, today);
  const closed = formatRoadmapDate(dates.end, today);
  return (
    <li>
      <RowFrame
        externalId={epic.externalId}
        route={route}
        selected={selected}
        overdue={overdue}
        linked
        indent
        left={
          <>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="line-clamp-2 min-w-0 text-fg [overflow-wrap:anywhere]">{epic.title || "(untitled)"}</span>
              <StatusPill status={epic.status} />
              {overdue && <OverduePill />}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
              <ProgressSummary progress={epic.progress} />
              <span>
                {started ? `Started ${started}` : "Not started"}
                {closed ? `, closed ${closed}` : ""}
              </span>
              {targetText && <span>{dates.targetFromMilestone ? `Milestone due ${targetText}` : `Target ${targetText}`}</span>}
            </span>
          </>
        }
        timeline={
          <>
            {bar && (
              <span
                data-epic-bar
                className={`absolute top-1/2 h-3 -translate-y-1/2 overflow-hidden rounded-full border ${
                  overdue ? "border-red-400/70 bg-red-500/15" : epic.status === "closed" ? "border-fg-muted/40 bg-fg-muted/15" : "border-accent/60 bg-accent/15"
                } ${bar.running ? "rounded-r-sm" : ""}`}
                style={{ left: pct(bar.from), width: pct(bar.to - bar.from) }}
              >
                <span className={`block h-full ${overdue ? "bg-red-400/60" : "bg-accent/70"}`} style={{ width: pct(share ?? 0) }} />
              </span>
            )}
            {target !== null && (
              <span
                data-target-marker
                className={`absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${overdue ? "bg-red-400" : dates.targetFromMilestone ? "bg-fg-muted/60" : "bg-fg"}`}
                style={{ left: pct(target) }}
              />
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
  left,
  timeline,
}: {
  externalId: string | null;
  route: RoadmapRoute;
  selected: boolean;
  overdue: boolean;
  linked: boolean;
  indent?: boolean;
  /** A group's milestone row: its title column is the group's heading. */
  heading?: boolean;
  left: ReactNode;
  timeline: ReactNode;
}) {
  const target: RoadmapRoute | null = linked && externalId !== null ? { ...route, item: externalId } : null;
  function open(e: MouseEvent<HTMLElement>) {
    if (target === null || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(target, "push");
  }
  const cell = `block min-w-0 py-1.5 pr-3 text-sm ${indent ? "pl-7" : "pl-3"}`;
  return (
    <div data-roadmap-row={externalId ?? undefined} data-overdue={overdue ? "true" : undefined} className={`group grid grid-cols-[var(--left)_minmax(0,1fr)] ${selected ? "bg-accent/10" : ""}`}>
      <div role={heading ? "heading" : undefined} aria-level={heading ? 3 : undefined} className={`sticky left-0 z-20 border-l-2 bg-ground ${selected ? "border-accent" : overdue ? "border-red-400/70" : "border-transparent"}`}>
        {target !== null ? (
          <a
            href={formatRoute(target)}
            onClick={open}
            aria-current={selected ? "true" : undefined}
            className={`${cell} rounded-md hover:bg-surface-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${selected ? "bg-accent/10" : ""}`}
          >
            {left}
          </a>
        ) : (
          <div className={cell}>{left}</div>
        )}
      </div>
      <div aria-hidden="true" onClick={target !== null ? open : undefined} className={`relative z-10 min-h-11 ${target !== null ? "cursor-pointer group-hover:bg-surface-strong/40" : ""}`}>
        {timeline}
      </div>
    </div>
  );
}

function MilestoneMarker({ dueAt, axis, today, overdue }: { dueAt: string | null; axis: Axis; today: number; overdue: boolean }) {
  const at = markerAt(axis, dueAt);
  if (at === null) return null;
  return (
    <span data-milestone-marker className="absolute top-1/2 flex -translate-y-1/2 items-center" style={{ left: pct(at) }}>
      <span className={`block h-3 w-3 -translate-x-1/2 rotate-45 border ${overdue ? "border-red-300 bg-red-400" : "border-accent bg-accent/80"}`} />
      <span className={`ml-1 whitespace-nowrap text-[11px] ${overdue ? "text-red-300" : "text-fg-muted"}`}>{formatRoadmapDate(dueAt, today)}</span>
    </span>
  );
}

function Diamond({ overdue }: { overdue: boolean }) {
  return (
    <span aria-hidden="true" className={`shrink-0 text-xs ${overdue ? "text-red-300" : "text-accent"}`}>
      ◆
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] font-normal text-fg-muted">{status.replace(/_/g, " ")}</span>;
}

function OverduePill() {
  return <span className="shrink-0 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-normal text-red-300">overdue</span>;
}

function ProgressSummary({ progress }: { progress: ProgressCounts }) {
  if (progress.total === 0) return <span data-progress="none">No items</span>;
  const share = progressShare(progress);
  return (
    <span data-progress={share === null ? "none" : formatShare(share)} className="inline-flex flex-wrap items-center gap-x-1.5 whitespace-nowrap">
      <span aria-hidden="true" className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-fg-muted/20">
        <span className="block h-full bg-accent" style={{ width: pct(share ?? 0) }} />
      </span>
      <span className="text-fg">
        {share === null ? "—" : formatShare(share)}
        <span className="sr-only">{share === null ? " no share: every item deferred" : " closed"}</span>
      </span>
      {progress.inProgress > 0 && <span>· {progress.inProgress} in progress</span>}
      {progress.deferred > 0 && <span>· {progress.deferred} deferred</span>}
    </span>
  );
}
