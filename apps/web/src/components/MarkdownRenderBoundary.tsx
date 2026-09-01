// Guards MarkdownEditor.tsx against a markdown parse it can't handle
// (bd-hmd.6 defensiveness — `marked`/`@tiptap/markdown` are generally
// robust, treating anything they don't recognize as literal text, but
// "generally" is not "provably", and ingested content is arbitrary).
//
// On a caught error, falls back to `rawContent` rendered as plain React
// text — the FIRST of the three safe options this ticket names ("plain
// text"), not markup: JSX text content is escaped unconditionally, the
// same guarantee lib/snippet.ts's header documents for the search-
// snippet path. A crash in the editor therefore degrades to inert text,
// never to nothing (silently hiding a node's content would be its own
// kind of bug) and never to unescaped HTML.

import { Component, type ReactNode } from "react";

interface Props {
  rawContent: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class MarkdownRenderBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Server-log-equivalent for the browser: visible in devtools, never
    // shown to the person beyond the plain-text fallback below.
    console.error("[breakdown-web] MarkdownEditor failed to render content; falling back to plain text.", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div>
          <p className="mb-2 text-xs text-amber-700">This content could not be rendered as rich text — showing it as plain text instead.</p>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-800">{this.props.rawContent}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
