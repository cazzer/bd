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
// than HTML in <foreignObject>, which an image would not lay out reliably; it
// is added to mermaid's `secure` keys (beside mermaid's own defaults) so a
// diagram's `%%{init}%%` directive or frontmatter cannot turn it back on.
//
// A source that does not parse — or a failure anywhere on the way to the
// image — shows the source as text with the reason (`suppressErrorRendering`
// makes mermaid throw instead of drawing its own error picture). A drawn
// diagram is a button that opens it in the review Lightbox, and offers its
// source as text beneath it.

import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";
import { diagramKindName } from "../lib/diagramKind.js";
import { DiagramSourceWithError } from "./DiagramStates.js";
import { Lightbox } from "./Lightbox.js";

let initialized = false;
let nextId = 0;

function ensureInitialized() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels"],
    // The app's palette (index.css @theme: fg #e2e8f0, fg-muted #94a3b8, a slate-800 fill) on a transparent ground; only the `base` theme takes all variables.
    theme: "base",
    darkMode: true,
    themeVariables: { darkMode: true, background: "transparent", primaryColor: "#1e293b", primaryTextColor: "#e2e8f0", primaryBorderColor: "#94a3b8", lineColor: "#94a3b8", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  });
  initialized = true;
}

type Drawn = { status: "pending" } | { status: "drawn"; src: string; width?: number; height?: number } | { status: "failed"; reason: string };

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** The root <svg> element's own size from its viewBox, so the image keeps its natural size and only ever shrinks to fit. */
function rootViewBoxSize(svg: string): { width?: number; height?: number } {
  const rootTag = /<svg\b[^>]*>/.exec(svg)?.[0];
  const match = rootTag && /\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/.exec(rootTag);
  if (!match) return {};
  const width = Math.ceil(Number(match[1]));
  const height = Math.ceil(Number(match[2]));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : {};
}

export interface MermaidDiagramProps {
  source: string;
  /** The figure's caption, shown by MermaidBlock; here only the enlarged view's title. */
  caption?: string;
  /** Whether the diagram is still being drawn; MermaidBlock owns the status region. */
  onPendingChange: (pending: boolean) => void;
  /** Scale the drawn diagram down to the parent's height (MermaidBlock `fill`). */
  fill?: boolean;
}

export function MermaidDiagram({ source, caption, onPendingChange, fill = false }: MermaidDiagramProps) {
  const [drawn, setDrawn] = useState<Drawn>({ status: "pending" });
  const [enlarged, setEnlarged] = useState(false);
  const enlargeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const kind = diagramKindName(source);

  const pending = drawn.status === "pending";
  useEffect(() => {
    onPendingChange(pending);
  }, [pending]);

  useEffect(() => {
    let current = true;
    setDrawn({ status: "pending" });
    ensureInitialized();
    mermaid
      .render(`evidence-mermaid-${++nextId}`, source)
      .then(({ svg }) => {
        if (current) setDrawn({ status: "drawn", src: SVG_DATA_URL_PREFIX + encodeURIComponent(svg), ...rootViewBoxSize(svg) });
      })
      .catch((error: unknown) => {
        if (current) setDrawn({ status: "failed", reason: `This diagram didn't render: ${error instanceof Error ? error.message : String(error)}` });
      });
    return () => {
      current = false;
    };
  }, [source]);

  // Back to the diagram once the Lightbox has closed (its dialog keeps the page inert until then).
  useEffect(() => {
    if (enlarged) returnFocus.current = true;
    else if (returnFocus.current) {
      returnFocus.current = false;
      enlargeRef.current?.focus();
    }
  }, [enlarged]);

  if (drawn.status === "pending") return null;
  if (drawn.status === "failed") return <DiagramSourceWithError source={source} reason={drawn.reason} />;
  return (
    <div className={`rounded-md border border-hairline bg-[#030509] p-3 ${fill ? "relative flex min-h-0 flex-1 flex-col" : ""}`}>
      <button
        ref={enlargeRef}
        type="button"
        aria-label={kind === "Diagram" ? "Enlarge diagram" : `Enlarge ${kind}`}
        onClick={() => setEnlarged(true)}
        className={`mx-auto block max-w-full cursor-zoom-in rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fill ? "min-h-0 w-full flex-1" : ""}`}
      >
        <img src={drawn.src} alt={kind} width={drawn.width} height={drawn.height} decoding="async" className={fill ? "block h-full w-full object-contain" : "block h-auto max-w-full"} />
      </button>
      <details className={`text-xs ${fill ? "absolute bottom-2 left-2 max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)] overflow-y-auto rounded border border-hairline bg-[#030509]/95 px-2 py-1 open:right-2" : "mt-2"}`}>
        <summary className="cursor-pointer rounded text-fg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">Diagram source</summary>
        <div className="mt-1.5 whitespace-pre-wrap font-mono leading-relaxed text-fg [overflow-wrap:anywhere]">{source}</div>
      </details>
      {enlarged && <Lightbox items={[{ name: caption ?? kind, path: kind, src: drawn.src }]} index={0} onIndexChange={() => {}} onClose={() => setEnlarged(false)} />}
    </div>
  );
}
