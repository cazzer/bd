// A review card's evidence: the bead description rendered read-only, with
// GFM tables, ```mermaid fences drawn as diagrams, and ```diff fences with
// added and removed lines distinguished (decision-card-reviews, design.md
// decision 3).
//
// Separate from MarkdownEditor on purpose: MarkdownEditor's extension set is
// shared with editing, and adding tables there would change how every
// editable node serializes. This renderer never edits, so nothing it adds
// reaches a node's stored markdown.
//
// Safety: the same argument as MarkdownEditor.tsx's header, which holds here
// unchanged — `@tiptap/markdown` turns markdown into typed ProseMirror JSON,
// never an HTML string; raw HTML in the source goes through a context-free
// DOMParser and the schema-constrained parser, which keeps only nodes the
// schema declares (no script, img, iframe, or raw-HTML node here either);
// links keep tiptap's render-time `isAllowedUri` guard. What this file adds:
//
//   - TableKit's table/row/header/cell nodes, rendered by their own `toDOM`
//     (createElement with colspan/rowspan/style attributes from the parsed
//     cell attributes, never markup).
//   - A code block node view: a ```diff fence through DiffBlock (React
//     text), a ```mermaid fence through MermaidBlock (whose SVG reaches the
//     page only as an <img> data URL — see MermaidDiagram.tsx), anything
//     else as a plain <pre> whose text ProseMirror renders, as in
//     MarkdownEditor.

import "./markdown-editor.css";
import "./evidence-view.css";
import { CodeBlock } from "@tiptap/extension-code-block";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { DiffBlock } from "./DiffBlock.js";
import { MarkdownRenderBoundary } from "./MarkdownRenderBoundary.js";
import { MermaidBlock } from "./MermaidBlock.js";

// ProseMirror always renders a code block's text into the node view's content
// element (tiptap appends it to the wrapper when the view names no target).
// A plain fence shows it as its <code>; a diagram or diff draws the text
// itself, so there the content element sits in a `hidden` container — kept
// for ProseMirror, never shown or announced twice.
function EvidenceCodeBlockView({ node }: ReactNodeViewProps) {
  const source = node.textContent;
  const language: unknown = node.attrs["language"];
  if (language !== "mermaid" && language !== "diff") {
    return (
      <NodeViewWrapper>
        <pre>
          <NodeViewContent<"code"> as="code" />
        </pre>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      {language === "mermaid" ? <MermaidBlock source={source} /> : <DiffBlock source={source} />}
      <div hidden>
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

const EvidenceCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EvidenceCodeBlockView);
  },
});

/** StarterKit's own code block is swapped for the one with the node view; tables get a wrapper that scrolls sideways when wide. */
const EXTENSIONS = [StarterKit.configure({ codeBlock: false }), Markdown, TableKit.configure({ table: { renderWrapper: true } }), EvidenceCodeBlock];

export interface EvidenceViewProps {
  /** The evidence markdown (the review bead's description). A new value re-renders the evidence. */
  markdown: string;
  ariaLabel?: string;
  className?: string;
}

/** Renders `markdown` read-only; a parse it cannot handle falls back to plain text (MarkdownRenderBoundary). */
export function EvidenceView({ markdown, ariaLabel, className }: EvidenceViewProps) {
  return (
    <MarkdownRenderBoundary rawContent={markdown}>
      <EvidenceDocument markdown={markdown} ariaLabel={ariaLabel} className={className} />
    </MarkdownRenderBoundary>
  );
}

function EvidenceDocument({ markdown, ariaLabel, className }: EvidenceViewProps) {
  // immediatelyRender: false, as in MarkdownEditor. The markdown is a
  // dependency, so a re-read that changes the evidence builds a fresh
  // document; useEditor destroys the previous editor itself.
  const editor = useEditor(
    {
      extensions: EXTENSIONS,
      content: markdown,
      contentType: "markdown",
      editable: false,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "markdown-editor-prosemirror evidence-view",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
      },
    },
    [markdown],
  );

  return <EditorContent editor={editor} className={className} />;
}
