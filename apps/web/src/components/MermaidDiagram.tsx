// Draws one mermaid diagram (decision-card-reviews, design.md decision 3).
// Loaded only through MermaidBlock's lazy import, so this module — and
// `mermaid` with it — is a separate chunk.
//
// Why the SVG cannot run anything: mermaid renders to an SVG string, and that
// string is shown ONLY as the `src` of an <img> (a `data:image/svg+xml` URL).
// An SVG loaded as an image is a static picture: browsers never run its
// script, never fire its event handlers, never follow its links, and never
// load external resources from it. The string is never put in the DOM —
// there is no `dangerouslySetInnerHTML` here, consistent with
// MarkdownEditor.tsx's header. mermaid's own `securityLevel: "strict"`
// sanitizer (labels are escaped, click handlers disabled) is a second layer,
// not the one relied on. `htmlLabels: false` draws labels as SVG text rather
// than HTML in <foreignObject>, which an image would not lay out reliably.
//
// A source that does not parse shows the source as text with mermaid's error
// (`suppressErrorRendering` stops mermaid drawing its own error picture
// instead of throwing).

import mermaid from "mermaid";
import { useEffect, useState } from "react";
import { DiagramPending, DiagramSourceWithError } from "./MermaidBlock.js";

let initialized = false;
let nextId = 0;

function ensureInitialized() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: "dark",
  });
  initialized = true;
}

type Drawn = { status: "pending" } | { status: "drawn"; src: string; width?: number; height?: number } | { status: "failed"; reason: string };

/** The SVG's own size from its viewBox, so the image keeps its natural size and only ever shrinks to fit. */
function viewBoxSize(svg: string): { width?: number; height?: number } {
  const match = /viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/.exec(svg);
  if (!match) return {};
  const width = Math.ceil(Number(match[1]));
  const height = Math.ceil(Number(match[2]));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : {};
}

export interface MermaidDiagramProps {
  source: string;
  /** The image's accessible name: the caption, or "Diagram". */
  label: string;
}

export function MermaidDiagram({ source, label }: MermaidDiagramProps) {
  const [drawn, setDrawn] = useState<Drawn>({ status: "pending" });

  useEffect(() => {
    let current = true;
    setDrawn({ status: "pending" });
    ensureInitialized();
    mermaid.render(`evidence-mermaid-${++nextId}`, source).then(
      ({ svg }) => {
        if (current) setDrawn({ status: "drawn", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, ...viewBoxSize(svg) });
      },
      (error: unknown) => {
        if (current) setDrawn({ status: "failed", reason: `This diagram didn't render: ${error instanceof Error ? error.message : String(error)}` });
      },
    );
    return () => {
      current = false;
    };
  }, [source]);

  if (drawn.status === "pending") return <DiagramPending />;
  if (drawn.status === "failed") return <DiagramSourceWithError source={source} reason={drawn.reason} />;
  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-ground p-3">
      <img src={drawn.src} alt={label} width={drawn.width} height={drawn.height} decoding="async" className="mx-auto block h-auto max-w-full" />
    </div>
  );
}
