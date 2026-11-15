// The board's and the roadmap's project switcher (roadmap-milestones,
// design.md decision 5): one compact menu offering "All projects" and each
// offered project, one at a time. A native <select>, so keyboard use (arrow
// keys, type-ahead, Enter/Space to open) and the screen-reader role and
// value come from the platform rather than a hand-rolled listbox. What the
// address means and what a choice navigates to is lib/workViewNav.ts; this
// component reports the choice and draws the state.
//
// An address naming several projects (an old multi-project link) has no
// option of its own to select, so a hidden, disabled "N projects" option
// stands for it: it reads as the closed switcher's label and can never be
// chosen.

import { useId } from "react";
import { ALL_PROJECTS_CHOICE, SEVERAL_PROJECTS_VALUE, switcherState } from "../lib/workViewNav.js";

export interface ProjectSwitcherProps {
  /** Every project the view offers, in the order to list them. */
  offered: readonly string[];
  /** The address's `project` list. */
  address: readonly string[];
  /** Called with `ALL_PROJECTS_CHOICE` or a key; never with the current value. */
  onChoose: (choice: string) => void;
}

export function ProjectSwitcher({ offered, address, onChoose }: ProjectSwitcherProps) {
  const state = switcherState(offered, address);
  const id = useId();
  return (
    <span className="relative inline-flex items-center">
      <label htmlFor={id} className="sr-only">
        Project
      </label>
      <select
        id={id}
        value={state.value}
        onChange={(e) => {
          if (e.target.value !== state.value) onChoose(e.target.value);
        }}
        className="min-h-11 max-w-56 cursor-pointer appearance-none truncate rounded-lg border border-hairline bg-surface-strong py-1 pl-2.5 pr-7 text-xs text-fg hover:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0"
      >
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
      </select>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 h-3 w-3 text-fg-muted">
        <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
