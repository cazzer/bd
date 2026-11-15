// How the roadmap answer becomes sections and groups (roadmap-milestones,
// design.md decision 7; work-roadmap spec, "The roadmap lays milestones and
// epics on a timeline" and "The roadmap is addressed by project"): one
// section per shown project, and in each, its milestones in due order
// (undated last, then title), each heading its epics, then "No milestone".
// Pure; the only import from @breakdown/core is a type (see boardRow.ts on
// why a runtime import must not reach the browser bundle).
//
// An epic's milestone may not be one of its project's own: beads keeps one
// project per tracker, but an agent can assert a `child_of` edge across
// projects, and the read names an epic's milestone wherever it lives, with
// its project, external id, and status. Such an epic is grouped under a
// header for that milestone in the epic's own section, labelled with the
// milestone's project.
//
// A project the last read did not cover (a switch whose answer has not
// landed) is a loading section, never left out and never empty, so a switch
// to "All projects" cannot flash a false "nothing planned".

import type { RoadmapEpic, RoadmapMilestone } from "@breakdown/core";

export type { RoadmapEpic, RoadmapMilestone };

/** A group's heading: a milestone of this project, one of another project, or "No milestone". */
export type RoadmapGroupHead =
  | { kind: "milestone"; milestone: RoadmapMilestone }
  | { kind: "foreign"; milestone: NonNullable<RoadmapEpic["milestone"]> }
  | { kind: "none" };

export interface RoadmapGroup {
  /** Stable key: the milestone's node id, or "none". */
  key: string;
  head: RoadmapGroupHead;
  epics: RoadmapEpic[];
}

export interface RoadmapSection {
  project: string;
  groups: RoadmapGroup[];
  /** True while the last read did not cover this project. */
  loading: boolean;
}

export const NO_MILESTONE_TITLE = "No milestone";

/** Milestone order: due date (undated last), then title, then id. Dates are canonical instants, so text order is time order. */
function compareHeads(a: { dueAt: string | null; title: string; id: string }, b: { dueAt: string | null; title: string; id: string }): number {
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt < b.dueAt ? -1 : 1;
  }
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function headKey(head: RoadmapGroupHead): { dueAt: string | null; title: string; id: string } {
  return head.kind === "none" ? { dueAt: null, title: "", id: "" } : head.milestone;
}

/**
 * The sections to draw, in `projects` order (the chosen projects). `read`
 * is the projects the answer covers (null: every project). With
 * `everyProject` (an address naming no project), a covered project with no
 * milestone and no epic is left out; otherwise every chosen project gets a
 * section, empty or not, so the view can say it has none yet. A project the
 * answer does not cover is a loading section either way.
 */
export function buildRoadmapSections(
  answer: { milestones: readonly RoadmapMilestone[]; epics: readonly RoadmapEpic[] },
  projects: readonly string[],
  everyProject: boolean,
  read: readonly string[] | null,
): RoadmapSection[] {
  const sections: RoadmapSection[] = [];
  for (const project of projects) {
    if (read !== null && !read.includes(project)) {
      sections.push({ project, groups: [], loading: true });
      continue;
    }
    const own = answer.milestones.filter((m) => m.project === project);
    const epics = answer.epics.filter((e) => e.project === project);
    if (everyProject && own.length === 0 && epics.length === 0) continue;

    const groups = new Map<string, RoadmapGroup>();
    for (const milestone of own) groups.set(milestone.id, { key: milestone.id, head: { kind: "milestone", milestone }, epics: [] });
    const none: RoadmapGroup = { key: "none", head: { kind: "none" }, epics: [] };
    for (const epic of epics) {
      const m = epic.milestone;
      if (m === null) {
        none.epics.push(epic);
        continue;
      }
      let group = groups.get(m.id);
      if (!group) {
        group = { key: m.id, head: { kind: "foreign", milestone: m }, epics: [] };
        groups.set(m.id, group);
      }
      group.epics.push(epic);
    }
    const ordered = [...groups.values()].sort((a, b) => compareHeads(headKey(a.head), headKey(b.head)));
    if (none.epics.length > 0) ordered.push(none);
    sections.push({ project, groups: ordered, loading: false });
  }
  return sections;
}

/**
 * The projects whose changes can change the shown roadmap: the projects
 * read, plus every project owning a shown epic's milestone (its due date and
 * status are drawn). Null when the read covered every project.
 */
export function watchedProjects(answer: { epics: readonly RoadmapEpic[] }, read: readonly string[] | null): string[] | null {
  if (read === null) return null;
  const watched = new Set(read);
  for (const e of answer.epics) if (e.milestone?.project) watched.add(e.milestone.project);
  return [...watched];
}

/** The project of the row whose external id is `item`, else the single chosen project, else null (the drawer waits). */
export function roadmapItemProject(item: string, sections: readonly RoadmapSection[], chosen: readonly string[]): string | null {
  for (const section of sections) {
    for (const group of section.groups) {
      if (group.head.kind !== "none" && group.head.milestone.externalId === item && group.head.milestone.project !== null) return group.head.milestone.project;
      for (const epic of group.epics) if (epic.externalId === item) return epic.project;
    }
  }
  return chosen.length === 1 ? chosen[0]! : null;
}
