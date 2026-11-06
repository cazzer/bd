// What a mermaid diagram shows while it is not drawn (decision-card-reviews,
// design.md decision 3): one status region per diagram, owned by MermaidBlock
// and kept mounted so the change is announced once, and the source with the
// reason when it cannot be drawn. Its own module so MermaidBlock (in the main
// chunk) and the lazily loaded MermaidDiagram share it without importing each
// other.

export function DiagramStatus({ pending }: { pending: boolean }) {
  return (
    <div role="status">
      {pending && <p className="flex min-h-32 items-center justify-center rounded-md border border-hairline bg-[#030509] px-3 text-xs text-fg-muted">Drawing diagram…</p>}
    </div>
  );
}

export function DiagramSourceWithError({ source, reason }: { source: string; reason: string }) {
  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3">
      <p className="whitespace-pre-wrap font-mono text-xs text-amber-200 [overflow-wrap:anywhere]">{reason}</p>
      <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-fg [overflow-wrap:anywhere]">{source}</div>
    </div>
  );
}
