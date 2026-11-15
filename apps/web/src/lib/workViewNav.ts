// Moving between the board and the roadmap, and between projects on either
// (roadmap-milestones, design.md decisions 5-6): the pure half of the
// project switcher (components/ProjectSwitcher.tsx) and the Board / Roadmap
// toggle (components/WorkViewToggle.tsx). Each answers the route to
// navigate to; the components own when.
//
// The switcher picks one project at a time, but an address may still name
// several (an old link, a review deep link), so its state has a third case
// besides "All projects" and one key: "N projects", which no choice
// produces and every choice replaces.

import { chosenChips } from "./boardRow.js";
import type { BoardRoute, RoadmapRoute } from "./route.js";

/** The switcher's value for "All projects". Never a project key: the key pattern needs at least one character. */
export const ALL_PROJECTS_CHOICE = "";

/** The switcher's value while the address names several projects; never a project key (the key pattern has no spaces). */
export const SEVERAL_PROJECTS_VALUE = "several projects";

export interface SwitcherState {
  /** What the closed switcher reads: "All projects", the one key, or "N projects". */
  label: string;
  /** The selected option: `ALL_PROJECTS_CHOICE`, the one key, or `SEVERAL_PROJECTS_VALUE`. */
  value: string;
}

/**
 * The switcher's state for an address's projects against the offered ones,
 * read the board's way (`chosenChips`): an empty or stale address is every
 * offered project, so it reads "All projects".
 */
export function switcherState(offered: readonly string[], address: readonly string[]): SwitcherState {
  const chosen = chosenChips(offered, address);
  if (chosen.length === offered.length) return { label: "All projects", value: ALL_PROJECTS_CHOICE };
  if (chosen.length === 1) return { label: chosen[0]!, value: chosen[0]! };
  return { label: `${chosen.length} projects`, value: SEVERAL_PROJECTS_VALUE };
}

/**
 * The route after choosing from the switcher: the address's `project`
 * replaced by the chosen key, or dropped for "All projects" (and for a key
 * that is not offered, or the only one offered, since either way every
 * offered project shows). Everything else in the route is kept.
 */
export function chooseProject<R extends BoardRoute | RoadmapRoute>(route: R, offered: readonly string[], choice: string): R {
  const projects = choice !== ALL_PROJECTS_CHOICE && offered.includes(choice) && offered.length > 1 ? [choice] : [];
  return { ...route, projects };
}

/**
 * The roadmap a board's toggle opens: its projects carried, its item and
 * view dropped. A board drawn from a view that names projects, with no
 * project in its address, shows the view's projects — "all" there is not
 * every registered project — so `viewChosen` (the projects it shows, or
 * null for a board with no such view) is carried in that case instead.
 */
export function boardToRoadmap(route: BoardRoute, viewChosen: readonly string[] | null): RoadmapRoute {
  const projects = route.projects.length === 0 && route.viewId !== null && viewChosen !== null ? [...viewChosen] : [...route.projects];
  return { view: "roadmap", projects, item: null };
}

/** The board a roadmap's toggle opens: its projects carried, its item dropped, no view. */
export function roadmapToBoard(route: RoadmapRoute): BoardRoute {
  return { view: "board", viewId: null, projects: [...route.projects], item: null };
}
