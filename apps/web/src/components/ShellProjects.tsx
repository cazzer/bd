// What the shell knows about projects (shared-nav-header, design.md
// decision 3), read once by App.tsx and shared with the header through
// context: the beads project registry (`beadsProjects`, read once on mount),
// and — on a board drawn from a saved view — that view's own projects, read
// by id, because the header's switcher offers them there instead of the
// registry. Only the header reads this; the board and the roadmap still
// read the registry themselves for their per-project ingest errors.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { filterProjects } from "../lib/boardRow.js";
import type { ShellProjects } from "../lib/shellNav.js";
import { viewFilterOf } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";

const ShellProjectsContext = createContext<ShellProjects>({ registry: null, registryFailed: false, boardView: null });

export function useShellProjects(): ShellProjects {
  return useContext(ShellProjectsContext);
}

export interface ShellProjectsProviderProps {
  /** The saved board view the address names, or null off the board or on a board with no view. */
  boardViewId: string | null;
  children: ReactNode;
}

export function ShellProjectsProvider({ boardViewId, children }: ShellProjectsProviderProps) {
  const [registry, setRegistry] = useState<string[] | null>(null);
  const [registryFailed, setRegistryFailed] = useState(false);
  const [boardView, setBoardView] = useState<ShellProjects["boardView"]>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.beadsProjects.query().then(
      (answer) => {
        if (!cancelled) setRegistry(answer.projects.map((p) => p.key));
      },
      () => {
        if (!cancelled) setRegistryFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boardViewId === null) return;
    let cancelled = false;
    trpc.getNodes.query({ ids: [boardViewId] }).then(
      ({ nodes }) => {
        if (cancelled) return;
        const node = nodes[0];
        const isBoardView = node !== undefined && node.nodeType === "view" && (node.metadata as Record<string, unknown>)["renderer"] === "board";
        const where = isBoardView ? (viewFilterOf(node) as { where?: unknown } | null)?.where : undefined;
        setBoardView({ viewId: boardViewId, projects: isBoardView ? filterProjects(where) : null });
      },
      // An unreadable view offers the registry, as the board does once it gives up on the view.
      () => {
        if (!cancelled) setBoardView({ viewId: boardViewId, projects: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [boardViewId]);

  const value = useMemo<ShellProjects>(() => ({ registry, registryFailed, boardView }), [registry, registryFailed, boardView]);
  return <ShellProjectsContext.Provider value={value}>{children}</ShellProjectsContext.Provider>;
}
