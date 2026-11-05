// A mermaid diagram (decision-card-reviews, design.md decision 3). Used for a
// ```mermaid fence in EvidenceView and, by the card's attachments, for a
// `mermaid` attachment. The renderer is lazy: `mermaid` is its own chunk,
// fetched the first time a diagram is drawn, so the board and the queue never
// pay for it (mermaidSplit.test.ts keeps every other import of it out).
// MermaidDiagram's header documents how the SVG reaches the page.
//
// The caption is the figure's <figcaption>; the image names the diagram's
// kind. One status region says "Drawing diagram…" from the moment the block
// mounts until the diagram is drawn or fails, across both the chunk load and
// mermaid's render. A chunk that fails to load (offline, a deploy replaced
// it) shows the source as text with the reason, like a diagram that does not
// parse — never a blank.

import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { DiagramSourceWithError, DiagramStatus } from "./DiagramStates.js";

const MermaidDiagram = lazy(async () => ({ default: (await import("./MermaidDiagram.js")).MermaidDiagram }));

export interface MermaidBlockProps {
  source: string;
  caption?: string;
}

export function MermaidBlock({ source, caption }: MermaidBlockProps) {
  const [pending, setPending] = useState(true);
  return (
    <figure className="min-w-0">
      {caption && <figcaption className="mb-1.5 text-xs text-fg-muted">{caption}</figcaption>}
      <DiagramLoadBoundary source={source}>
        <DiagramStatus pending={pending} />
        <Suspense fallback={null}>
          <MermaidDiagram source={source} caption={caption} onPendingChange={setPending} />
        </Suspense>
      </DiagramLoadBoundary>
    </figure>
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
