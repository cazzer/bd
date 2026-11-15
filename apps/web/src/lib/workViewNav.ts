// Moving between the board and the roadmap, and between projects on either
// (roadmap-milestones, design.md decisions 5-6): the pure half of the
// project switcher (components/ProjectSwitcher.tsx) and the Board / Roadmap
// toggle (components/WorkViewToggle.tsx). Each answers the route to
// navigate to; the components own when.
//
// The switcher picks one project at a time, but an address may still name
// several (an old link, a review deep link), so its state has a third case
// besides "All projects" and one key — the projects named, or how many —
// which no choice produces and every choice replaces. A switch, like the
// toggle, drops the open item: the drawer belongs to what was shown before.

import { chosenProjects, offeredProjects } from "./boardRow.js";
import type { BoardRoute, RoadmapRoute } from "./route.js";

/** The switcher's value for "All projects". Never a project key: the key pattern needs at least one character. */
export const ALL_PROJECTS_CHOICE = "";

/** The switcher's value while the address names several projects; never a project key (the key pattern has no spaces). */
export const SEVERAL_PROJECTS_VALUE = "several projects";

/** At most this many chosen keys are named in the label ("a + b + c"); more read "N projects". */
export const MAX_NAMED_PROJECTS = 3;

export interface SwitcherState {
  /** What the closed switcher reads: "All projects", the one key, "a + b", or "N projects". */
  label: string;
  /** The selected option: `ALL_PROJECTS_CHOICE`, the one key, or `SEVERAL_PROJECTS_VALUE`. */
  value: string;
  /** Every chosen key, for a label that only counts them; null otherwise. */
  title: string | null;
}

/**
 * The switcher's state for an address's projects against the offered ones,
 * read the board's way (`chosenProjects`): an empty or stale address is
 * every offered project, so it reads "All projects". While the offered
 * projects are still loading (`offered` null), the address alone is read:
 * none is "All projects", one is that key.
 */
export function switcherState(offered: readonly string[] | null, address: readonly string[]): SwitcherState {
  const chosen = offered === null ? address : chosenProjects(offered, address);
  if (chosen.length === 0 || (offered !== null && chosen.length === offered.length)) return { label: "All projects", value: ALL_PROJECTS_CHOICE, title: null };
  if (chosen.length === 1) return { label: chosen[0]!, value: chosen[0]!, title: null };
  if (chosen.length <= MAX_NAMED_PROJECTS) return { label: chosen.join(" + "), value: SEVERAL_PROJECTS_VALUE, title: null };
  return { label: `${chosen.length} projects`, value: SEVERAL_PROJECTS_VALUE, title: chosen.join(", ") };
}

/**
 * The route after choosing from the switcher: the address's `project`
 * replaced by the chosen key, or dropped for "All projects" (and for a key
 * that is not offered, or the only one offered, since either way every
 * offered project shows), and the open item dropped. The view is kept.
 */
export function chooseProject<R extends BoardRoute | RoadmapRoute>(route: R, offered: readonly string[], choice: string): R {
  const projects = choice !== ALL_PROJECTS_CHOICE && offered.includes(choice) && offered.length > 1 ? [choice] : [];
  return { ...route, projects, item: null };
}

/**
 * The projects a board drawn from a view shows, for the toggle to carry:
 * the view's own projects narrowed by the address, known without the
 * registry, so the Roadmap link is right while the board loads or after a
 * read fails. Null when the view names no projects (or there is none yet),
 * meaning the address's projects are carried as they are.
 */
export function viewCarriedProjects(viewProjects: readonly string[] | null, address: readonly string[]): string[] | null {
  return viewProjects === null ? null : chosenProjects(offeredProjects(viewProjects, []), address);
}

/**
 * The roadmap a board's toggle opens: its projects carried, its item and
 * view dropped. A board drawn from a view that names projects, with no
 * project in its address, shows the view's projects — "all" there is not
 * every registered project — so `viewChosen` (`viewCarriedProjects`) is
 * carried in that case instead.
 */
export function boardToRoadmap(route: BoardRoute, viewChosen: readonly string[] | null): RoadmapRoute {
  const projects = route.projects.length === 0 && route.viewId !== null && viewChosen !== null ? [...viewChosen] : [...route.projects];
  return { view: "roadmap", projects, item: null };
}

/** The board a roadmap's toggle opens: its projects carried, its item dropped, no view. */
export function roadmapToBoard(route: RoadmapRoute): BoardRoute {
  return { view: "board", viewId: null, projects: [...route.projects], item: null };
}
