// tiptap-backed markdown rendering/editing (bd-hmd.6, tasks.md 6.2).
//
// One component, two modes (`editable` prop), because both need the
// identical safety property and duplicating the setup would risk the two
// drifting:
//
//   - editable=false: a file-backed (read-only) node's content, or the
//     read-only view of any node before Edit is pressed.
//   - editable=true: an editable node (human/agent source system) being
//     edited, or the annotation/note-creation composer.
//
// --- Why this is safe against the XSS class bd-hmd.3 found -------------
//
// bd-hmd.3 shipped a stored XSS by rendering `ts_headline` output through
// `dangerouslySetInnerHTML`; the fix there was "parse into segments and
// let React escape everything" (lib/snippet.ts). Node content is a
// different shape of the same hazard: arbitrary ingested markdown that
// may itself contain raw HTML, and naively rendering markdown -> HTML ->
// `dangerouslySetInnerHTML` would reopen the identical class of bug for
// every node this app can display, not just search snippets.
//
// This component never does that conversion. `@tiptap/markdown`'s parser
// does not turn markdown into an HTML string at all — it tokenizes with
// `marked` and converts each token into typed ProseMirror JSON (a plain
// object tree: `{ type: 'paragraph', content: [...] }`, never a string of
// markup) via per-node-type handlers. The one exception is a raw-HTML
// token embedded IN the markdown source: `@tiptap/markdown` parses that
// through `generateJSON`, which uses the browser's `DOMParser` (which,
// per spec, produces a Document with no browsing context — its scripts
// never execute and its images never load, unlike assigning `innerHTML`
// on a live element) and then ProseMirror's OWN schema-constrained DOM
// parser, which keeps only what the schema declares (this app's schema —
// StarterKit's default node/mark set plus Markdown — has no `<script>`,
// `<img>`, `<iframe>`, or raw-HTML-passthrough node at all, so those tags
// contribute no node; their text content, if any, is extracted as inert
// text, never executed). The one schema mark that touches a URL, Link, is
// tiptap's default build, whose `isAllowedUri` allow-lists
// http/https/ftp/ftps/mailto/tel/callto/sms/cid/xmpp and strips any other
// `href` (so `javascript:`/`data:` links are dropped, not rendered) — see
// this ticket's report for the verbatim source checked.
//
// Once parsed, EVERY node/mark is rendered by ProseMirror's own `toDOM`
// for that type — real `document.createElement`/`textContent` calls the
// schema defines, never a string handed to `.innerHTML`. This file (and
// this app) contains no `dangerouslySetInnerHTML` anywhere.
//
// Read-only rendering therefore goes through the exact same parse/render
// path as editing, just with `editable: false` — ProseMirror parses,
// never injects, matching the "tiptap in non-editable mode" option this
// ticket names directly.

import "./markdown-editor.css";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

/**
 * Fixed extension set for every editor instance in this app — StarterKit
 * (paragraphs, headings, lists, blockquote, code/code block, bold/italic/
 * strike, links with the safe default `isAllowedUri`, history) plus
 * Markdown (the parse/serialize layer, see module header). Never
 * extended with an Image or raw-HTML-passthrough node — see module
 * header on why that absence is load-bearing for the XSS argument, not
 * incidental.
 */
const EXTENSIONS = [StarterKit, Markdown];

export interface MarkdownEditorProps {
  /** Markdown source — the node's own `content` field. Only read once, at mount: callers that need a different node's content should remount with a fresh `key` (DetailPanel does this, keyed by node id) rather than expect this component to react to a changed prop. */
  initialContent: string;
  editable: boolean;
  /** Called once the editor instance exists, handing back a snapshot function the caller can invoke on Save to get the current markdown — never called automatically, so a caller that never calls it never touches the editor's content. */
  onReady?: (getMarkdown: () => string) => void;
  className?: string;
  ariaLabel?: string;
}

/**
 * Renders `initialContent` (markdown) through tiptap. See this module's
 * header for why this is the safe path for content that may contain raw
 * HTML, and why it's shared between read-only and editable rendering
 * rather than two separate implementations.
 */
export function MarkdownEditor({ initialContent, editable, onReady, className, ariaLabel }: MarkdownEditorProps) {
  // immediatelyRender: false — this app is client-only (no SSR), but
  // tiptap's React integration still warns without an explicit value,
  // and `false` is also the safer choice under StrictMode's deliberate
  // double-invocation of effects (avoids constructing two live editor
  // instances against the same DOM node before the first is torn down).
  const editor = useEditor(
    {
      extensions: EXTENSIONS,
      content: initialContent,
      contentType: "markdown",
      editable,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "markdown-editor-prosemirror",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
      },
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (editor && onReady) {
      onReady(() => editor.getMarkdown());
    }
    // Deliberately only re-runs when the editor instance itself changes —
    // `onReady` is expected to be referentially stable enough per mount
    // (DetailPanel/composers call this once per editor lifetime); the
    // point is handing the caller a live snapshot function, not
    // resubscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    return () => editor?.destroy();
  }, [editor]);

  return <EditorContent editor={editor} className={className} />;
}
