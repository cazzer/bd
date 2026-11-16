// Moving between projects (roadmap-milestones, design.md decisions 5-6): the
// pure half of the project switcher (components/ProjectSwitcher.tsx), now in
// the shell header. Each answers the route to navigate to; the components
// own when. The Board / Roadmap toggle is gone (shared-nav-header, design.md
// decision 4): the header's nav links (lib/shellNav.ts) replace it, and its
// view-carrying rule, `viewCarriedProjects`, is kept for them.
//
// The switcher picks one project at a time, but an address may still name
// several (an old link, a review deep link), so its state has a third case
// besides "All projects" and one key — the projects named, or how many —
// which no choice produces and every choice replaces. A switch on the
// board or roadmap drops the open item: the drawer belongs to what was shown
// before.

import { chosenProjects, offeredProjects } from "./boardRow.js";
import type { Route } from "./route.js";

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
 * offered project shows). The view is kept. On the board and the roadmap
 * the open item is dropped too — the drawer belongs to what was shown
 * before; on every other route only `projects` changes (shared-nav-header,
 * design.md decision 2).
 */
export function chooseProject<R extends Route>(route: R, offered: readonly string[], choice: string): R {
  const projects = choice !== ALL_PROJECTS_CHOICE && offered.includes(choice) && offered.length > 1 ? [choice] : [];
  return route.view === "board" || route.view === "roadmap" ? { ...route, projects, item: null } : { ...route, projects };
}

/**
 * The projects a board drawn from a view shows, for the header's links to carry:
 * the view's own projects narrowed by the address, known without the
 * registry, so the Roadmap link is right while the board loads or after a
 * read fails. Null when the view names no projects (or there is none yet),
 * meaning the address's projects are carried as they are.
 */
export function viewCarriedProjects(viewProjects: readonly string[] | null, address: readonly string[]): string[] | null {
  return viewProjects === null ? null : chosenProjects(offeredProjects(viewProjects, []), address);
}

/** What the switcher offers (ProjectSwitcher's `offered` and `fallback`). */
export interface SwitcherOffer {
  /** The projects to offer; null while they are not known yet (the switcher is disabled). */
  offered: string[] | null;
  /** True when the registry could not be read and `offered` is the address's own projects. */
  fallback: boolean;
}

/**
 * What the board's or the roadmap's switcher offers, known as soon as its
 * source is, independent of the board or roadmap read: a view's own
 * projects (`viewProjects`, known without the registry), else the
 * registry's keys once read, else — the registry having failed — the
 * address's projects as a fallback, so a reader can always switch away from
 * a project that fails to read. Null while none of these is known.
 */
export function switcherOffer(source: {
  viewProjects: readonly string[] | null;
  registry: readonly string[] | null;
  registryFailed: boolean;
  address: readonly string[];
}): SwitcherOffer {
  if (source.viewProjects !== null) return { offered: offeredProjects(source.viewProjects, []), fallback: false };
  if (source.registry !== null) return { offered: offeredProjects(null, source.registry), fallback: false };
  if (source.registryFailed) return { offered: [...source.address], fallback: true };
  return { offered: null, fallback: false };
}
