// Placeholder for the board view (live-beads-board, task 2.5): mounted by the
// shell under `/board` so the address, the renderer offer, and the route
// round-trip are real before the board itself exists. It names the view id
// and the chosen projects the address carries and draws nothing else; group 4
// replaces this file with the board (columns, lanes, live updates).

export interface BoardViewProps {
  viewId: string | null;
  projects: string[];
}

export function BoardView({ viewId, projects }: BoardViewProps) {
  return (
    <main className="flex h-dvh w-screen flex-col items-center justify-center gap-1 px-4 text-sm text-fg-muted">
      <p>Board view — not drawn yet.</p>
      <p>
        View: <span className="text-fg">{viewId ?? "none"}</span>
      </p>
      <p>
        Projects: <span className="text-fg">{projects.length > 0 ? projects.join(", ") : "all"}</span>
      </p>
    </main>
  );
}
