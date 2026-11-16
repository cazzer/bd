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
// board, the roadmap); `"below-sm"` hides it only on a phone, where the
// header's Menu button names the place and the row is needed for tabs.
// Below `sm` a long title (a search for 500 characters) is cut to two lines,
// its full text in the tooltip. `column` narrows the row to the view's own
// content column (the feed's and timeline's `max-w-3xl`, padded like their
// `px-4` columns), so the title starts where the rows do; it is a class
// string, written out at the call site so Tailwind sees it. Without it the
// row is inset like the full-width views' panels (`px-3`).

import type { ReactNode } from "react";

/** A button in a toolbar's end slot (Refresh): the header controls' height from `sm`, a 44px target below. */
export const TOOLBAR_BUTTON =
  "min-h-11 rounded-lg border border-hairline px-3 py-1 font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:min-h-7";

export interface ViewToolbarProps {
  title: string;
  /** Keep the h1 for screen readers only, everywhere or below `sm`. */
  titleHidden?: boolean | "below-sm";
  /** A short line after the title (a count, the anchor); announced politely. */
  status?: ReactNode;
  /** Controls after the title, on the left (tabs). */
  children?: ReactNode;
  /** Controls at the row's end (Refresh, a graph link, key hints); `null` or `false` draws no end slot. */
  actions?: ReactNode;
  /** Width classes for the row's content, e.g. "max-w-3xl"; absent: the full width. */
  column?: string;
  inert?: boolean;
}

export function ViewToolbar({ title, titleHidden = false, status, children, actions, column, inert }: ViewToolbarProps) {
  return (
    <div inert={inert} data-view-toolbar="" className="shrink-0">
      <div className={`flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 py-2 ${column === undefined ? "px-3" : `mx-auto w-full px-4 ${column}`}`}>
        {titleHidden === true ? (
          <h1 className="sr-only">{title}</h1>
        ) : (
          <div className={`flex min-w-0 flex-wrap items-baseline gap-x-3 ${titleHidden === "below-sm" ? "max-sm:sr-only" : ""}`}>
            <h1 title={title} className="line-clamp-2 max-w-full min-w-0 text-base font-semibold break-words text-fg sm:block sm:truncate">
              {title}
            </h1>
            {status !== undefined && (
              <p role="status" className="min-w-0 text-xs text-fg-muted">
                {status}
              </p>
            )}
          </div>
        )}
        {children}
        {actions !== undefined && actions !== null && actions !== false && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3 text-xs text-fg-muted">{actions}</div>
        )}
      </div>
    </div>
  );
}
