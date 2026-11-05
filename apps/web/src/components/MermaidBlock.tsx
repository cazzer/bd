// A mermaid diagram (decision-card-reviews, design.md decision 3). Used for a
// ```mermaid fence in EvidenceView and, by the card's attachments, for a
// `mermaid` attachment. The renderer is lazy: `mermaid` is its own chunk,
// fetched the first time a diagram is drawn, so the board and the queue never
// pay for it. MermaidDiagram's header documents how the SVG reaches the page.
//
// A chunk that fails to load (offline, a deploy replaced it) shows the source
// as text with the reason, like a diagram that does not parse — never a blank.

import { Component, lazy, Suspense, type ReactNode } from "react";

const MermaidDiagram = lazy(async () => ({ default: (await import("./MermaidDiagram.js")).MermaidDiagram }));

export interface MermaidBlockProps {
  source: string;
  caption?: string;
}

export function MermaidBlock({ source, caption }: MermaidBlockProps) {
  return (
    <figure className="min-w-0">
      {caption && <figcaption className="mb-1.5 text-xs text-fg-muted">{caption}</figcaption>}
      <DiagramLoadBoundary source={source}>
        <Suspense fallback={<DiagramPending />}>
          <MermaidDiagram source={source} label={caption ?? "Diagram"} />
        </Suspense>
      </DiagramLoadBoundary>
    </figure>
  );
}

export function DiagramPending() {
  return (
    <p role="status" className="rounded-md border border-hairline bg-surface-strong px-3 py-6 text-center text-xs text-fg-muted">
      Drawing diagram…
    </p>
  );
}

export function DiagramSourceWithError({ source, reason }: { source: string; reason: string }) {
  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3">
      <p className="whitespace-pre-wrap break-words text-xs text-amber-200">{reason}</p>
      <div className="mt-2 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-fg">{source}</div>
    </div>
  );
}

class DiagramLoadBoundary extends Component<{ source: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error("[breakdown-web] the diagram renderer failed to load.", error);
  }

  render(): ReactNode {
    if (this.state.error !== null) return <DiagramSourceWithError source={this.props.source} reason={`Couldn't load the diagram renderer: ${this.state.error}`} />;
    return this.props.children;
  }
}
