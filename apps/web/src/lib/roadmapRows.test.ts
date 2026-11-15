import { describe, expect, it } from "vitest";
import { buildRoadmapSections, roadmapItemProject, watchedProjects, type RoadmapEpic, type RoadmapMilestone } from "./roadmapRows.js";

const EMPTY = { total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0 };

function milestone(id: string, dueAt: string | null, over: Partial<RoadmapMilestone> = {}): RoadmapMilestone {
  return { id, externalId: `x-${id}`, title: id, status: "open", project: "p", dueAt, progress: EMPTY, unepicked: EMPTY, ...over };
}
type EpicMilestone = NonNullable<RoadmapEpic["milestone"]>;
const named = (m: RoadmapMilestone): EpicMilestone => ({ id: m.id, externalId: m.externalId, title: m.title, status: m.status, project: m.project, dueAt: m.dueAt });
function epic(id: string, m: EpicMilestone | null, over: Partial<RoadmapEpic> = {}): RoadmapEpic {
  return { id, externalId: `x-${id}`, title: id, status: "open", project: "p", milestone: m, dueAt: null, startedAt: null, closedAt: null, firstStartedAt: null, progress: EMPTY, ...over };
}

const heads = (sections: ReturnType<typeof buildRoadmapSections>) =>
  sections.map((s) => [s.project, s.groups.map((g) => (g.head.kind === "milestone" ? g.head.milestone.title : g.head.kind === "foreign" ? `foreign:${g.head.milestone.title}` : "none"))]);

describe("buildRoadmapSections", () => {
  it("orders milestones January, March, undated, then No milestone", () => {
    const jan = milestone("jan", "2027-01-10T00:00:00.000Z");
    const mar = milestone("mar", "2027-03-10T00:00:00.000Z");
    const undated = milestone("undated", null);
    const sections = buildRoadmapSections({ milestones: [mar, undated, jan], epics: [epic("e1", named(mar)), epic("e2", null), epic("e3", named(jan))] }, ["p"], false, ["p"]);
    expect(heads(sections)).toEqual([["p", ["jan", "mar", "undated", "none"]]]);
    expect(sections[0]!.groups[0]!.epics.map((e) => e.id)).toEqual(["e3"]);
    expect(sections[0]!.groups[3]!.epics.map((e) => e.id)).toEqual(["e2"]);
  });

  it("breaks a due-date tie by title, and leaves No milestone off when every epic has one", () => {
    const b = milestone("b", "2027-01-10T00:00:00.000Z");
    const a = milestone("a", "2027-01-10T00:00:00.000Z");
    expect(heads(buildRoadmapSections({ milestones: [b, a], epics: [epic("e", named(a))] }, ["p"], false, ["p"]))).toEqual([["p", ["a", "b"]]]);
  });

  it("gives every chosen project a section, even an empty one, when projects are chosen", () => {
    expect(buildRoadmapSections({ milestones: [], epics: [] }, ["p"], false, ["p"])).toEqual([{ project: "p", groups: [], loading: false }]);
  });

  it("with every project, leaves out read projects with no milestone and no epic, in the given order", () => {
    const q = milestone("q", null, { project: "q" });
    const sections = buildRoadmapSections({ milestones: [q], epics: [epic("e", null, { project: "r" })] }, ["p", "r", "q"], true, null);
    expect(sections.map((s) => s.project)).toEqual(["r", "q"]);
  });

  it("keeps a project the last read did not cover as a loading section, even with every project (no false empty state on a switch)", () => {
    const m = milestone("m", null, { project: "p" });
    const sections = buildRoadmapSections({ milestones: [m], epics: [] }, ["p", "q", "r"], true, ["p"]);
    expect(sections.map((s) => [s.project, s.loading])).toEqual([
      ["p", false],
      ["q", true],
      ["r", true],
    ]);
  });

  it("groups an epic under a milestone of another project, labelled with that project, status, and external id", () => {
    const other = milestone("other", "2026-12-01T00:00:00.000Z", { project: "q", title: "Q launch", status: "closed" });
    const sections = buildRoadmapSections({ milestones: [other], epics: [epic("e", named(other))] }, ["p", "q"], false, ["p", "q"]);
    const [p, q] = sections;
    expect(p!.groups).toHaveLength(1);
    expect(p!.groups[0]!.head).toEqual({ kind: "foreign", milestone: named(other) });
    expect(q!.groups[0]!.head.kind).toBe("milestone");
    expect(q!.groups[0]!.epics).toEqual([]);
  });

  it("orders a foreign milestone among the project's own by due date", () => {
    const own = milestone("own", "2027-01-01T00:00:00.000Z");
    const far: EpicMilestone = { id: "far", externalId: "z-1", title: "Far", status: "open", project: "z", dueAt: "2026-12-01T00:00:00.000Z" };
    expect(heads(buildRoadmapSections({ milestones: [own], epics: [epic("e", far)] }, ["p"], false, ["p"]))).toEqual([["p", ["foreign:Far", "own"]]]);
  });
});

describe("watchedProjects", () => {
  it("is every project when every project was read", () => {
    expect(watchedProjects({ epics: [] }, null)).toBeNull();
  });

  it("adds the projects owning shown epics' milestones to the projects read", () => {
    const far: EpicMilestone = { id: "far", externalId: "z-1", title: "Far", status: "open", project: "z", dueAt: null };
    expect(watchedProjects({ epics: [epic("e", far), epic("f", null)] }, ["p"])).toEqual(["p", "z"]);
  });
});

describe("roadmapItemProject", () => {
  const m = milestone("m", null, { project: "q" });
  const far: EpicMilestone = { id: "far", externalId: "z-1", title: "Far", status: "open", project: "z", dueAt: null };
  const sections = buildRoadmapSections({ milestones: [m], epics: [epic("e", named(m), { project: "q" }), epic("f", far)] }, ["p", "q"], true, null);

  it("is the project of the milestone or epic row with that external id, a foreign milestone's included", () => {
    expect(roadmapItemProject("x-m", sections, ["p", "q"])).toBe("q");
    expect(roadmapItemProject("x-e", sections, ["p", "q"])).toBe("q");
    expect(roadmapItemProject("z-1", sections, ["p", "q"])).toBe("z");
  });

  it("is the single chosen project before the item is shown, else null", () => {
    expect(roadmapItemProject("x-missing", sections, ["p"])).toBe("p");
    expect(roadmapItemProject("x-missing", sections, ["p", "q"])).toBeNull();
  });
});
