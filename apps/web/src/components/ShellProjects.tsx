// What the shell knows about projects and the current saved view
// (shared-nav-header, design.md decision 3), read by App.tsx and shared
// with the header through context:
//
// - the beads project registry (`beadsProjects`), read once on mount. A
//   failed read is retried when the reader next focuses the switcher
//   (`retryRegistry`), never on a timer. The board and the roadmap read the
//   registry themselves on every live read (for each project's `lastIngest`
//   error) and hand each answer here (`reportRegistry`), so a project
//   registered while one of them is open reaches the switcher at once, at
//   no cost of its own;
// - the saved view the address names (feed, code, timeline, or a board's
//   `view`), read by id: its title names the collapsed Menu, and a board
//   view's own projects are what the header's switcher offers there.
//
// Only the header reads it.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { filterProjects } from "../lib/boardRow.js";
import type { ShellProjects, ShellView } from "../lib/shellNav.js";
import { viewFilterOf } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";

export interface ShellProjectsValue extends ShellProjects {
  /** Read the registry again; a no-op unless the last read failed. */
  retryRegistry: () => void;
  /** A registry answer a view read for itself (the board's, the roadmap's): the shell takes it as its own. */
  reportRegistry: (keys: readonly string[]) => void;
}

const ShellProjectsContext = createContext<ShellProjectsValue>({ registry: null, registryFailed: false, view: null, retryRegistry: () => {}, reportRegistry: () => {} });

function sameKeys(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((k, i) => k === b[i]);
}

export function useShellProjects(): ShellProjectsValue {
  return useContext(ShellProjectsContext);
}

export interface ShellProjectsProviderProps {
  /** The saved view the address names, or null when it names none. */
  viewId: string | null;
  children: ReactNode;
}

export function ShellProjectsProvider({ viewId, children }: ShellProjectsProviderProps) {
  const [registry, setRegistry] = useState<string[] | null>(null);
  const [registryFailed, setRegistryFailed] = useState(false);
  const [registryRead, setRegistryRead] = useState(0);
  const [view, setView] = useState<ShellView | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.beadsProjects.query().then(
      (answer) => {
        if (cancelled) return;
        setRegistry(answer.projects.map((p) => p.key));
        setRegistryFailed(false);
      },
      () => {
        if (!cancelled) setRegistryFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [registryRead]);

  const retryRegistry = useCallback(() => {
    if (registryFailed) setRegistryRead((n) => n + 1);
  }, [registryFailed]);

  useEffect(() => {
    if (viewId === null) return;
    let cancelled = false;
    trpc.getNodes.query({ ids: [viewId] }).then(
      ({ nodes }) => {
        if (cancelled) return;
        const node = nodes[0];
        if (node === undefined || node.nodeType !== "view") {
          setView({ viewId, title: null, renderer: null, projects: null });
          return;
        }
        const renderer = (node.metadata as Record<string, unknown>)["renderer"];
        const where = (viewFilterOf(node) as { where?: unknown } | null)?.where;
        setView({ viewId, title: node.title, renderer: typeof renderer === "string" ? renderer : null, projects: filterProjects(where) });
      },
      // An unreadable view: the switcher offers the registry, as the board does once it gives up on the view.
      () => {
        if (!cancelled) setView({ viewId, title: null, renderer: null, projects: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  const reportRegistry = useCallback((keys: readonly string[]) => {
    setRegistry((prev) => (sameKeys(prev, keys) ? prev : [...keys]));
    setRegistryFailed(false);
  }, []);

  const value = useMemo<ShellProjectsValue>(() => ({ registry, registryFailed, view, retryRegistry, reportRegistry }), [registry, registryFailed, view, retryRegistry, reportRegistry]);
  return <ShellProjectsContext.Provider value={value}>{children}</ShellProjectsContext.Provider>;
}
