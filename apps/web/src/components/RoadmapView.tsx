// The roadmap view (roadmap-milestones, design.md decision 6), mounted by
// the shell (App.tsx) under `/roadmap?project=<key>&item=<id>`
// (lib/route.ts). For now only its header, laid out as the board's so the
// switcher and toggle do not move between the two (its h1 is for screen
// readers): the project switcher the board uses, offering every registered
// project (disabled, reading the address, while they load; a switch drops
// the open item), and the Board / Roadmap toggle,
// which carries the projects back to `/board` and drops the item; and the
// review queue's pill, placed here as every view places it. The
// timeline, its rows, and the item drawer come with task group 4.

import { useEffect, useState } from "react";
import { offeredProjects } from "../lib/boardRow.js";
import { navigate } from "../lib/navigate.js";
import type { RoadmapRoute } from "../lib/route.js";
import { chooseProject, roadmapToBoard } from "../lib/workViewNav.js";
import { trpc } from "../trpc.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ReviewQueuePill } from "./ReviewQueue.js";
import { WorkViewToggle } from "./WorkViewToggle.js";

export interface RoadmapViewProps {
  projects: string[];
  /** The external id whose drawer is open; null when none is. */
  item: string | null;
}

export function RoadmapView({ projects, item }: RoadmapViewProps) {
  const [registered, setRegistered] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.beadsProjects
      .query()
      .then((answer) => {
        if (!cancelled) setRegistered(answer.projects.map((p) => p.key));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to read the projects.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const route: RoadmapRoute = { view: "roadmap", projects, item };
  const offered = registered === null ? null : offeredProjects(null, registered);

  return (
    <main className="flex h-dvh w-screen flex-col overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <header className="glass m-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <h1 className="sr-only">Roadmap</h1>
        {offered?.length !== 0 && <ProjectSwitcher offered={offered} address={projects} onChoose={(choice) => offered && navigate(chooseProject(route, offered, choice), "push")} />}
        <WorkViewToggle current="roadmap" board={roadmapToBoard(route)} roadmap={route} />
        <div className="ml-auto flex items-center text-xs text-fg-muted">
          <ReviewQueuePill />
        </div>
      </header>
      {error && (
        <p role="alert" className="m-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </main>
  );
}
