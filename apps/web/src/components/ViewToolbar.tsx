// A view's own toolbar (shared-nav-header, design.md decision 1; app-
// navigation spec "Every view shares one header"): the row under the shell
// header holding what belongs to the view alone — its title and status
// line, tabs, Refresh, a link that carries the view's node or text to the
// graph — so the header holds only navigation, project, status and the
// review control. One style on every view: the same height, inset and title
// size, whatever the view puts in it.
//
// `title` is the view's h1. With `titleHidden` it is for screen readers
// only, for a view the header's current nav link already names (the plain
// board). `column` narrows the row to the view's own content column (the
// feed's and timeline's `max-w-3xl`, padded like their `px-4` columns), so
// the title starts where the rows do; it is a class string, written out at the call site so Tailwind sees it.

import type { ReactNode } from "react";

export interface ViewToolbarProps {
  title: ReactNode;
  /** Keep the h1 for screen readers only. */
  titleHidden?: boolean;
  /** A short line after the title (a count, a path); announced politely. */
  status?: ReactNode;
  /** Controls after the title, on the left (tabs). */
  children?: ReactNode;
  /** Controls at the row's end (Refresh, a graph link, key hints). */
  actions?: ReactNode;
  /** Width classes for the row's content, e.g. "max-w-3xl"; absent: the full width. */
  column?: string;
  inert?: boolean;
}

export function ViewToolbar({ title, titleHidden = false, status, children, actions, column, inert }: ViewToolbarProps) {
  return (
    <div inert={inert} data-view-toolbar="" className="shrink-0">
      <div className={`flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 ${column === undefined ? "" : `mx-auto w-full ${column}`}`}>
        {titleHidden ? (
          <h1 className="sr-only">{title}</h1>
        ) : (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <h1 className="max-w-full min-w-0 text-base font-semibold break-words text-fg sm:truncate">{title}</h1>
            {status !== undefined && (
              <p role="status" className="min-w-0 text-xs text-fg-muted">
                {status}
              </p>
            )}
          </div>
        )}
        {children}
        {actions !== undefined && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3 text-xs text-fg-muted">{actions}</div>}
      </div>
    </div>
  );
}
