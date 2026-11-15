import { describe, expect, it } from "vitest";
import { buildRoadmapSections, roadmapItemProject, unreturnedMilestoneIds, type RoadmapEpic, type RoadmapMilestone } from "./roadmapRows.js";

const EMPTY = { total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0 };

function milestone(id: string, dueAt: string | null, over: Partial<RoadmapMilestone> = {}): RoadmapMilestone {
  return { id, externalId: `x-${id}`, title: id, status: "open", project: "p", dueAt, progress: EMPTY, unepicked: EMPTY, ...over };
}
function epic(id: string, m: RoadmapMilestone | { id: string; title: string; dueAt: string | null } | null, over: Partial<RoadmapEpic> = {}): RoadmapEpic {
  return {
    id,
    externalId: `x-${id}`,
    title: id,
    status: "open",
    project: "p",
    milestone: m === null ? null : { id: m.id, title: m.title, dueAt: m.dueAt },
    dueAt: null,
    startedAt: null,
    closedAt: null,
    firstStartedAt: null,
    progress: EMPTY,
    ...over,
  };
}

const heads = (sections: ReturnType<typeof buildRoadmapSections>) =>
  sections.map((s) => [s.project, s.groups.map((g) => (g.head.kind === "milestone" ? g.head.milestone.title : g.head.kind === "foreign" ? `foreign:${g.head.title}` : "none"))]);

describe("buildRoadmapSections", () => {
  it("orders milestones January, March, undated, then No milestone", () => {
    const jan = milestone("jan", "2027-01-10T00:00:00.000Z");
    const mar = milestone("mar", "2027-03-10T00:00:00.000Z");
    const undated = milestone("undated", null);
    const sections = buildRoadmapSections({ milestones: [mar, undated, jan], epics: [epic("e1", mar), epic("e2", null), epic("e3", jan)] }, ["p"], false);
    expect(heads(sections)).toEqual([["p", ["jan", "mar", "undated", "none"]]]);
    expect(sections[0]!.groups[0]!.epics.map((e) => e.id)).toEqual(["e3"]);
    expect(sections[0]!.groups[3]!.epics.map((e) => e.id)).toEqual(["e2"]);
  });

  it("breaks a due-date tie by title, and leaves No milestone off when every epic has one", () => {
    const b = milestone("b", "2027-01-10T00:00:00.000Z");
    const a = milestone("a", "2027-01-10T00:00:00.000Z");
    expect(heads(buildRoadmapSections({ milestones: [b, a], epics: [epic("e", a)] }, ["p"], false))).toEqual([["p", ["a", "b"]]]);
  });

  it("gives every chosen project a section, even an empty one, when projects are chosen", () => {
    expect(buildRoadmapSections({ milestones: [], epics: [] }, ["p"], false)).toEqual([{ project: "p", groups: [] }]);
  });

  it("with every project, leaves out projects with no milestone and no epic, in the given order", () => {
    const q = milestone("q", null, { project: "q" });
    const sections = buildRoadmapSections({ milestones: [q], epics: [epic("e", null, { project: "r" })] }, ["p", "r", "q"], true);
    expect(sections.map((s) => s.project)).toEqual(["r", "q"]);
  });

  it("groups an epic under a milestone of another shown project, labelled with that project", () => {
    const other = milestone("other", "2026-12-01T00:00:00.000Z", { project: "q", title: "Q launch" });
    const sections = buildRoadmapSections({ milestones: [other], epics: [epic("e", other)] }, ["p", "q"], false);
    const [p, q] = sections;
    expect(p!.groups).toHaveLength(1);
    expect(p!.groups[0]!.head).toMatchObject({ kind: "foreign", title: "Q launch", project: "q", externalId: "x-other", dueAt: "2026-12-01T00:00:00.000Z" });
    expect(q!.groups[0]!.head.kind).toBe("milestone");
    expect(q!.groups[0]!.epics).toEqual([]);
  });

  it("groups an epic under a milestone of a project not shown, labelled from the lookup or unknown", () => {
    const named = { id: "far", title: "Far launch", dueAt: null };
    const answer = { milestones: [], epics: [epic("e", named)] };
    expect(buildRoadmapSections(answer, ["p"], false)[0]!.groups[0]!.head).toMatchObject({ kind: "foreign", title: "Far launch", project: null, externalId: null });
    const looked = buildRoadmapSections(answer, ["p"], false, new Map([["far", { externalId: "z-1", project: "z" }]]));
    expect(looked[0]!.groups[0]!.head).toMatchObject({ kind: "foreign", project: "z", externalId: "z-1" });
    expect(unreturnedMilestoneIds(answer)).toEqual(["far"]);
  });

  it("orders a foreign milestone among the project's own by due date", () => {
    const own = milestone("own", "2027-01-01T00:00:00.000Z");
    const far = { id: "far", title: "Far", dueAt: "2026-12-01T00:00:00.000Z" };
    expect(heads(buildRoadmapSections({ milestones: [own], epics: [epic("e", far)] }, ["p"], false))).toEqual([["p", ["foreign:Far", "own"]]]);
  });
});

describe("roadmapItemProject", () => {
  const m = milestone("m", null, { project: "q" });
  const sections = buildRoadmapSections({ milestones: [m], epics: [epic("e", m, { project: "q" })] }, ["p", "q"], true);

  it("is the project of the milestone or epic row with that external id", () => {
    expect(roadmapItemProject("x-m", sections, ["p", "q"])).toBe("q");
    expect(roadmapItemProject("x-e", sections, ["p", "q"])).toBe("q");
  });

  it("is the single chosen project before the item is shown, else null", () => {
    expect(roadmapItemProject("x-missing", sections, ["p"])).toBe("p");
    expect(roadmapItemProject("x-missing", sections, ["p", "q"])).toBeNull();
  });
});
