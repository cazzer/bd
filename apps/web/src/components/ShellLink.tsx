// A link the shell header draws: a real address, so a modified or
// non-primary click is the browser's (a new tab, a copied link), and a
// plain click is a history push through `navigate` — the rule the old Board
// / Roadmap toggle followed, shared by every header link.

import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type Route } from "../lib/route.js";

export interface ShellLinkProps {
  route: Route;
  current?: boolean;
  className: string;
  /** Called after a plain click has navigated (a menu closing on its choice). */
  onNavigate?: () => void;
  children: ReactNode;
}

export function ShellLink({ route, current = false, className, onNavigate, children }: ShellLinkProps) {
  function go(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(route, "push");
    onNavigate?.();
  }
  return (
    <a href={formatRoute(route)} onClick={go} aria-current={current ? "page" : undefined} className={className}>
      {children}
    </a>
  );
}
