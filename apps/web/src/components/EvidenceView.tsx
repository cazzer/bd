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
//   - TableKit's row/header/cell nodes and a table node, rendered by their
//     own `toDOM` (createElement with colspan/rowspan/style attributes from
//     the parsed cell attributes, never markup). The table sits in a
//     keyboard-focusable region, so a wide one can be scrolled sideways
//     without a mouse.
//   - Headings rendered two levels down (`#` is an <h3>, capped at <h6>): the
//     evidence sits under the card's own headings, so a `#` in it must not
//     outrank them.
//   - A code block node view: a ```diff fence through DiffBlock (React
//     text), a ```mermaid fence through MermaidBlock (whose SVG reaches the
//     page only as an <img> data URL — see MermaidDiagram.tsx), anything
//     else as a plain <pre> whose text ProseMirror renders, as in
//     MarkdownEditor.
//
// The hosting section names the evidence (the drawer's "Evidence" heading),
// so this component takes no label of its own.

import "./markdown-editor.css";
import "./evidence-view.css";
import { mergeAttributes } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { Table, TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { DiffBlock } from "./DiffBlock.js";
import { MarkdownRenderBoundary } from "./MarkdownRenderBoundary.js";
import { MermaidBlock } from "./MermaidBlock.js";

/** Marks a node view whose content React draws (a diff, a diagram); ProseMirror leaves its events to the browser. */
const DRAWN_BLOCK = "data-evidence-block";

// ProseMirror always renders a code block's text into the node view's content
// element (tiptap appends it to the wrapper when the view names no target).
// A plain fence shows it as its <code>; a diagram or diff draws the text
// itself, so there the content element sits in a `hidden` container — kept
// for ProseMirror, never shown or announced twice. A drawn block is
// contentEditable=false and its events are stopped (below), so ProseMirror's
// mouse handling never takes a text selection, a button press, or a
// <details> toggle inside it, and a selection made there is ignored rather
// than mapped back to a document position (which collapsed it).
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
    <NodeViewWrapper contentEditable={false} {...{ [DRAWN_BLOCK]: "" }}>
      {language === "mermaid" ? <MermaidBlock source={source} /> : <DiffBlock source={source} />}
      <div hidden>
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

function elementOf(target: EventTarget | Node | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

function insideDrawnBlock(target: EventTarget | Node | null): boolean {
  return elementOf(target)?.closest(`[${DRAWN_BLOCK}]`) != null;
}

const EvidenceCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EvidenceCodeBlockView, {
      stopEvent: ({ event }) => insideDrawnBlock(event.target),
      // Inside a drawn block everything is React's. Elsewhere, tiptap's
      // default: selections and changes in the content element are
      // ProseMirror's, the rest of the view is not.
      ignoreMutation: ({ mutation }) => {
        if (insideDrawnBlock(mutation.target)) return true;
        if (mutation.type === "selection") return false;
        return elementOf(mutation.target)?.closest("[data-node-view-content-react]") == null;
      },
    });
  },
});

const EvidenceHeading = Heading.extend({
  renderHTML({ node, HTMLAttributes }) {
    const level = Math.min(Number(node.attrs["level"]) + 2, 6);
    return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

// `View: null`: the table's node view (TableView, used even when not
// resizable) draws a bare wrapper; without it, this renderHTML draws the table.
const EvidenceTable = Table.extend({
  renderHTML(props) {
    return ["div", { class: "tableWrapper", role: "region", tabindex: "0", "aria-label": "Table" }, this.parent!(props)];
  },
}).configure({ View: null });

/** StarterKit's code block and heading, and TableKit's table, are swapped for the versions above. */
const EXTENSIONS = [StarterKit.configure({ codeBlock: false, heading: false }), Markdown, TableKit.configure({ table: false }), EvidenceTable, EvidenceHeading, EvidenceCodeBlock];

export interface EvidenceViewProps {
  /** The evidence markdown (the review bead's description). A new value re-renders the evidence. */
  markdown: string;
  className?: string;
}

/** Renders `markdown` read-only; a parse it cannot handle falls back to plain text (MarkdownRenderBoundary). */
export function EvidenceView({ markdown, className }: EvidenceViewProps) {
  return (
    <MarkdownRenderBoundary rawContent={markdown}>
      <EvidenceDocument markdown={markdown} className={className} />
    </MarkdownRenderBoundary>
  );
}

function EvidenceDocument({ markdown, className }: EvidenceViewProps) {
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
      editorProps: { attributes: { class: "markdown-editor-prosemirror evidence-view" } },
    },
    [markdown],
  );

  return <EditorContent editor={editor} className={className} />;
}
