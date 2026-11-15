// The Board / Roadmap toggle (roadmap-milestones, work-board spec "Board and
// Roadmap are sibling views"): two links, the current one marked
// `aria-current="page"`, so each is a real address (a modified click opens
// it in a new tab) and a plain click is a history push. The caller supplies
// both routes (lib/workViewNav.ts says what each carries).

import type { MouseEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type BoardRoute, type RoadmapRoute } from "../lib/route.js";

export interface WorkViewToggleProps {
  current: "board" | "roadmap";
  board: BoardRoute;
  roadmap: RoadmapRoute;
}

export function WorkViewToggle({ current, board, roadmap }: WorkViewToggleProps) {
  const links: Array<{ id: "board" | "roadmap"; label: string; route: BoardRoute | RoadmapRoute }> = [
    { id: "board", label: "Board", route: board },
    { id: "roadmap", label: "Roadmap", route: roadmap },
  ];
  return (
    <nav aria-label="Board or roadmap" className="inline-flex rounded-lg border border-hairline p-0.5 text-xs">
      {links.map(({ id, label, route }) => {
        const on = id === current;
        function go(e: MouseEvent<HTMLAnchorElement>) {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate(route, "push");
        }
        return (
          <a
            key={id}
            href={formatRoute(route)}
            onClick={go}
            aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-md px-2.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0 ${
              on ? "bg-accent/20 font-medium text-fg" : "text-fg-muted hover:bg-surface-strong hover:text-fg"
            }`}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
