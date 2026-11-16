// The board's and the roadmap's project switcher (roadmap-milestones,
// design.md decision 5): one compact menu offering "All projects" and each
// offered project, one at a time. A native <select>, so keyboard use (arrow
// keys, type-ahead, Enter/Space to open) and the screen-reader role and
// value come from the platform rather than a hand-rolled listbox. What the
// address means and what a choice navigates to is lib/workViewNav.ts; this
// component reports the choice and draws the state.
//
// An address naming several projects (an old multi-project link) has no
// option of its own to select, so a hidden, disabled option stands for it:
// it reads as the closed switcher's label and can never be chosen.
//
// The box has a fixed width in every state, so nothing beside it moves
// when the projects load: while they load (`offered` null) it is a disabled
// select reading the address alone, and with only one project offered there
// is nothing to choose, so that key is shown as text in the same box.
//
// When the project registry could not be read (`fallback`), `offered` is the
// address's own projects: the switcher is still a live menu, reading the
// address as while loading and offering "All projects" beside them, so a
// reader can always switch away from a project that fails to read.
//
// On a view `project` does not filter (the shell header on the graph, feed,
// code, timeline or inbox — shared-nav-header, design.md decision 3), the
// caller passes a `hint` saying so: the box's tooltip and its accessible
// description.

import { useId } from "react";
import { ALL_PROJECTS_CHOICE, SEVERAL_PROJECTS_VALUE, switcherState } from "../lib/workViewNav.js";

export interface ProjectSwitcherProps {
  /** Every project the view offers, in the order to list them; null while they load. */
  offered: readonly string[] | null;
  /** The address's `project` list. */
  address: readonly string[];
  /** Called with `ALL_PROJECTS_CHOICE` or a key; never with the current value. */
  onChoose: (choice: string) => void;
  /** True when the registry could not be read and `offered` is the address's projects. */
  fallback?: boolean;
  /** Said of a view the choice does not filter ("The inbox is not filtered by project."): tooltip and accessible description. */
  hint?: string | null;
}

const BOX = "min-h-11 w-36 rounded-lg border py-1 pl-2.5 text-base sm:min-h-0 sm:w-44 sm:text-xs";

export function ProjectSwitcher({ offered, address, onChoose, fallback = false, hint = null }: ProjectSwitcherProps) {
  const state = switcherState(fallback ? null : offered, address);
  const id = useId();

  if (!fallback && offered !== null && offered.length === 1) {
    return (
      <span className={`${BOX} inline-flex items-center truncate border-transparent pr-2.5 text-fg`} title={hint ?? undefined} aria-description={hint ?? undefined}>
        <span className="sr-only">Project: </span>
        {offered[0]}
      </span>
    );
  }

  const loading = offered === null;
  return (
    <span className="relative inline-flex items-center">
      <label htmlFor={id} className="sr-only">
        Project
      </label>
      <select
        id={id}
        value={state.value}
        disabled={loading}
        title={[state.title, hint].filter((t) => t !== null).join("\n") || undefined}
        aria-description={hint ?? undefined}
        onChange={(e) => {
          if (e.target.value !== state.value) onChoose(e.target.value);
        }}
        className={`${BOX} cursor-pointer appearance-none truncate border-fg-muted/30 bg-surface-strong pr-7 text-fg hover:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-default disabled:text-fg-muted disabled:hover:border-fg-muted/30`}
      >
        {loading ? (
          <option value={state.value}>{state.label}</option>
        ) : (
          <>
            {state.value === SEVERAL_PROJECTS_VALUE && (
              <option value={SEVERAL_PROJECTS_VALUE} disabled hidden>
                {state.label}
              </option>
            )}
            <option value={ALL_PROJECTS_CHOICE}>All projects</option>
            {offered.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </>
        )}
      </select>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 h-3 w-3 text-fg-muted">
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
