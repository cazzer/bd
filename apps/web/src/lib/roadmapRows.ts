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
// projects, and the read names an epic's milestone wherever it lives. Such
// an epic is grouped under a header for that milestone in the epic's own
// section, labelled with the milestone's project — from the answer when
// that project is shown too, else from `elsewhere` (the view's lookup of
// the milestones the answer names but does not return), else unknown.

import type { RoadmapEpic, RoadmapMilestone } from "@breakdown/core";

export type { RoadmapEpic, RoadmapMilestone };

/** A milestone the answer names (an epic's) without returning, as the view looked it up. */
export interface ElsewhereMilestone {
  externalId: string;
  project: string;
}

/** A group's heading: a milestone of this project, or one of another project (or of no project the view could find). */
export type RoadmapGroupHead =
  | { kind: "milestone"; milestone: RoadmapMilestone }
  | { kind: "foreign"; id: string; title: string; dueAt: string | null; externalId: string | null; project: string | null; milestone: RoadmapMilestone | null }
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
  if (head.kind === "milestone") return head.milestone;
  if (head.kind === "foreign") return head;
  return { dueAt: null, title: "", id: "" };
}

/**
 * The sections to draw, in `projects` order (the chosen projects). With
 * `everyProject` (an address naming no project), a project with no
 * milestone and no epic is left out; otherwise every chosen project gets a
 * section, empty or not, so the view can say it has none yet.
 */
export function buildRoadmapSections(
  answer: { milestones: readonly RoadmapMilestone[]; epics: readonly RoadmapEpic[] },
  projects: readonly string[],
  everyProject: boolean,
  elsewhere: ReadonlyMap<string, ElsewhereMilestone> = new Map(),
): RoadmapSection[] {
  const milestoneById = new Map(answer.milestones.map((m) => [m.id, m]));
  const sections: RoadmapSection[] = [];
  for (const project of projects) {
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
        const known = milestoneById.get(m.id) ?? null;
        const found = elsewhere.get(m.id);
        group = {
          key: m.id,
          head: {
            kind: "foreign",
            id: m.id,
            title: known?.title ?? m.title,
            dueAt: known?.dueAt ?? m.dueAt,
            externalId: known?.externalId ?? found?.externalId ?? null,
            project: known?.project ?? found?.project ?? null,
            milestone: known,
          },
          epics: [],
        };
        groups.set(m.id, group);
      }
      group.epics.push(epic);
    }
    const ordered = [...groups.values()].sort((a, b) => compareHeads(headKey(a.head), headKey(b.head)));
    if (none.epics.length > 0) ordered.push(none);
    sections.push({ project, groups: ordered });
  }
  return sections;
}

/** The milestones epics name that the answer does not return: the ids the view looks up to label them. */
export function unreturnedMilestoneIds(answer: { milestones: readonly RoadmapMilestone[]; epics: readonly RoadmapEpic[] }): string[] {
  const returned = new Set(answer.milestones.map((m) => m.id));
  const ids = new Set<string>();
  for (const e of answer.epics) if (e.milestone !== null && !returned.has(e.milestone.id)) ids.add(e.milestone.id);
  return [...ids].sort();
}

/** The project of the row whose external id is `item`, else the single chosen project, else null (the drawer waits). */
export function roadmapItemProject(item: string, sections: readonly RoadmapSection[], chosen: readonly string[]): string | null {
  for (const section of sections) {
    for (const group of section.groups) {
      if (group.head.kind === "milestone" && group.head.milestone.externalId === item) return group.head.milestone.project;
      if (group.head.kind === "foreign" && group.head.externalId === item && group.head.project !== null) return group.head.project;
      for (const epic of group.epics) if (epic.externalId === item) return epic.project;
    }
  }
  return chosen.length === 1 ? chosen[0]! : null;
}
