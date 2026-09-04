// Node detail panel (bd-hmd.6, tasks.md 6.1-6.3, 6.5): opened by "a click
// both expands and selects" (App.tsx's `handleNodeClick` — see that
// file's header for why this is the whole answer to the gesture
// conflict, not a new gesture of its own). Shows content, type, source
// system, degree, and — for a file-backed node — its origin; gates
// editing on the node's own `isEditable` (server-computed, see
// server/dto.ts's header — this file never re-derives
// `sourceSystem === 'repo'`); offers annotation from any node, including
// read-only ones; and hand edge editing (assert/retract/reweight) for
// edges touching this node.
//
// Every write here calls its tRPC procedure directly and, on success,
// hands the RESULT up to App.tsx via a callback prop — App.tsx alone
// owns `graph` state and decides how to merge a write's result onto the
// canvas (graph/expansion.ts's pin-then-merge functions), the same
// separation `expandNode` already established for bd-hmd.5.
//
// bd-bxr: this panel moved from a bordered flex sibling of the canvas to
// a floating `.glass` overlay, fixed in App.tsx's right column below the
// type control. Every prop and every write path is unchanged; only the
// visual shell and this file's own dark-token classes moved. The one new
// behaviour is the Escape-to-close effect below — the panel becoming an
// overlay (rather than a layout sibling with an implicit boundary)
// removes the old click-away path's only affordance, so an explicit key
// handler is added alongside the pre-existing close button.
//
// bd-8ub review, must-fix 2: that Escape handler was originally a bare
// `window` keydown listener, so pressing Escape while typing in any of
// THIS panel's own inputs/selects/the MarkdownEditor (contenteditable)
// closed the panel and discarded the in-progress edit — Escape's own
// ordinary "cancel/blur what I'm typing in" behaviour never got a chance
// to apply first. Fixed by moving the handler onto the panel's root
// `<aside>` (`onKeyDown`, not a `window` listener) and checking the
// event's own target: inside an editable element, Escape blurs it and
// stops there; anywhere else in the panel, Escape closes it exactly as
// before.
//
// bd-8ub review, should-fix 6: opening the panel (a fresh `nodeId`) moves
// focus to its own heading (`headingRef`, `tabIndex={-1}` — a heading
// isn't focusable by default) after capturing whatever was focused
// beforehand (`previouslyFocusedRef`); closing it (× or Escape, both
// routed through `handleClose` below) restores focus to that captured
// element if it's still a real restoration target (bd-e9n review:
// deliberately not just "still in the document" — see `handleClose`'s
// own comment on why `document.body` itself has to be excluded), or the
// search input, or — bd-e9n review's second fallback — the canvas
// container, so a stale/absent capture never bottoms out on `<body>`.
// Both fallback targets are looked up by a stable `id` (this file's own
// lookup keys), deliberately not a new prop threaded down from App.tsx —
// see `handleClose`'s comment.
//
// bd-e9n, design.md decision 6: opening a node now defaults to a
// "summary" panelState (title, meta row, lib/firstParagraph.ts's excerpt
// of the content — no editor, no annotate/edge controls) with a "Show
// more" control expanding to everything this file already had
// (ContentSection/editor, AnnotateSection, the edge list, ConnectForm).
// `panelState` is local `useState`, defaulting to "summary" on every
// mount — App.tsx already remounts this component per `key={nodeId}`
// (see the doc comment above), so a fresh selection needs no explicit
// reset here. Heading focus, the Escape handler, and the close button
// are unchanged by any of this — they operate on the `<aside>` itself,
// not on which state is showing inside it. Editing (ContentSection's
// edit affordance) only renders in the expanded state; the excerpt shown
// in summary is plain text, not routed through MarkdownRenderBoundary/
// MarkdownEditor — a full editor instance is more than a one-paragraph
// excerpt needs, and JSX text content already escapes it exactly the
// way that boundary's own plain-text fallback does (see that file's
// header).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HUMAN_SOURCE_SYSTEM } from "../graph/expansion.js";
import type { GraphLink, GraphNode } from "../graph/encoding.js";
import { edgesTouchingNode, endpointId } from "../graph/nodeEdges.js";
import { firstParagraph } from "../lib/firstParagraph.js";
import { trpc } from "../trpc.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { MarkdownRenderBoundary } from "./MarkdownRenderBoundary.js";

type LookedUpNode = Awaited<ReturnType<typeof trpc.getNodes.query>>["nodes"][number];
type AnnotateResult = Awaited<ReturnType<typeof trpc.annotateNode.mutate>>;
type AssertResult = Awaited<ReturnType<typeof trpc.assertEdge.mutate>>;

type FetchState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; node: LookedUpNode };

export interface DetailPanelProps {
  nodeId: string;
  /** All currently-drawn nodes — for the "connect to..." target picker (task 6.5) and this node's own degree/type/source (already known from the graph, so opening the panel doesn't need to wait on a fetch for those). */
  allNodes: readonly GraphNode[];
  /** All currently-drawn links — filtered here (graph/nodeEdges.ts) to the ones touching this node. */
  allLinks: readonly GraphLink[];
  onClose: () => void;
  /**
   * The panel's summary/expanded state changed (bd-e9n, design.md
   * decision 6) — called only from the "Show more"/"Show less" toggle
   * below, never on mount: a fresh `nodeId` always starts in summary
   * (this component's own `useState`), and App.tsx's `key={selectedNodeId}`
   * on this component already guarantees a genuinely new mount per
   * selection, so there is nothing to reset from an effect. App.tsx uses
   * this only to size the shared right column and GraphCanvas's
   * `insetRight` — DetailPanel itself is the sole owner of the state.
   */
  onExpandedChange?: (expanded: boolean) => void;
  /** A content/title edit was saved — App.tsx patches the canvas node's own title (graph/expansion.ts's `mergeNodePatch`). */
  onContentSaved: (nodeId: string, newTitle: string) => void;
  /** An annotation was created — App.tsx draws the note and its edge via `mergeExpansion` (task 6.3's required reuse). */
  onAnnotated: (target: GraphNode, result: AnnotateResult, title: string | undefined) => void;
  /** A hand edge was asserted between this node and another already-drawn node. */
  onEdgeAsserted: (input: { srcId: string; dstId: string; edgeType: string; weight?: number }, result: AssertResult) => void;
  onEdgeRetracted: (linkId: string) => void;
  onEdgeReweighted: (linkId: string, weight: number) => void;
  /**
   * node-views (design.md decision 8), generalized by code-view (design.md
   * decision 5): this node's effective default view, resolved by
   * GraphView.tsx after selection and handed down — `null` or absent while
   * unresolved, after a failed resolution, or when nothing applies. Only a
   * `feed`, `code`, or `timeline` renderer earns an offer; `graph` is where
   * the person already is, and a view row written outside the contract
   * (renderer null) names nothing to open. The panel only ever offers,
   * never navigates on its own.
   */
  defaultView?: ResolvedDefaultView | null;
  /** "Open as feed · …" / "Open as code · …" / "Open as timeline · …" was chosen — GraphView.tsx pushes `/feed?view=<id>`, `/code?view=<id>&node=<selected>`, or `/timeline?view=<id>&node=<selected>` (it owns the guards a push out of the graph must disarm first, so the navigation is its call, not this panel's). */
  onOpenDefaultView?: (view: OfferedView) => void;
}

type ResolvedDefaultView = Awaited<ReturnType<typeof trpc.resolveDefaultViews.query>>["results"][number];

/** The renderers the detail panel can offer to open — the ones another view draws (timeline-view, design.md decision 6). */
export type OfferedRenderer = "feed" | "code" | "timeline";

/** What `onOpenDefaultView` receives: the view to open and the renderer that decides which address GraphView.tsx pushes. */
export interface OfferedView {
  id: string;
  renderer: OfferedRenderer;
}

function isOfferedRenderer(renderer: string | null): renderer is OfferedRenderer {
  return renderer === "feed" || renderer === "code" || renderer === "timeline";
}

/** Closest editable ancestor of `target` (inclusive), if any — an `input`/`textarea`/`select`, or a `[contenteditable="true"]` region (the MarkdownEditor). Escape inside one of these must blur it, not close the whole panel (bd-8ub review, must-fix 2). */
function closestEditable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const editable = target.closest('input, textarea, select, [contenteditable="true"]');
  return editable instanceof HTMLElement ? editable : null;
}

/**
 * App.tsx's SearchBar renders the one search input this whole app has,
 * tagged with this stable `id` — the first-choice fallback focus target
 * when a panel closes and whatever was focused before it opened is gone
 * (bd-8ub review, should-fix 6). A selector, not a new prop: threading a
 * ref down from App.tsx for a single fallback lookup would be more
 * surface for the same one-line answer. An `id` selector, not the
 * aria-label attribute selector this used before (bd-e9n review): a
 * stable identifier meant for exactly this lookup, rather than
 * incidentally matching on copy that's free to change for i18n/wording
 * reasons unrelated to this fallback.
 */
const SEARCH_INPUT_SELECTOR = "#search-input";

/**
 * GraphCanvas.tsx's own canvas container, tagged with this stable `id`
 * (and made programmatically focusable there via `tabIndex={-1}`) — the
 * LAST-resort fallback focus target (bd-e9n review) when closing this
 * panel: the previously-focused element is gone AND, for whatever
 * reason, the search input can't be found either. Restoring focus to
 * SOMETHING inside the page beats leaving it to fall through to
 * `<body>`, which swallows the next Tab press with no visible focus ring
 * anywhere.
 */
const CANVAS_CONTAINER_SELECTOR = "#graph-canvas-container";

function originLabel(node: LookedUpNode): string {
  // A file-backed node's origin IS its externalId — packages/core/src/seed.ts
  // sets externalId to the repo-relative path for every `repo`-sourced
  // node (its own SOURCE_SYSTEM constant). Not re-deriving "is this a
  // file" here — `!node.isEditable` (the server's own predicate, see
  // this file's header) is what gates showing this at all.
  return node.externalId;
}

/** Read-only info row: label + value, styled consistently across the panel. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </div>
  );
}

function ContentSection({ node, onSaved }: { node: LookedUpNode; onSaved: (title: string) => void }) {
  const [title, setTitle] = useState(node.title);
  const [saveState, setSaveState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "saved" }>({ kind: "idle" });
  const [getMarkdown, setGetMarkdown] = useState<(() => string) | null>(null);

  if (!node.isEditable) {
    return (
      <div>
        <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          This node's content comes from a file ({originLabel(node)}) and can't be edited here — <code>pnpm db:seed</code> would overwrite a hand edit the next time it
          runs. Annotate it instead (below) to attach your own note.
        </p>
        <MarkdownRenderBoundary rawContent={node.content}>
          <MarkdownEditor key={node.id} initialContent={node.content} editable={false} ariaLabel={`${node.title || "(untitled)"} content, read only`} />
        </MarkdownRenderBoundary>
      </div>
    );
  }

  async function handleSave() {
    if (!getMarkdown) return;
    setSaveState({ kind: "saving" });
    try {
      const content = getMarkdown();
      await trpc.updateNodeContent.mutate({ nodeId: node.id, title, content });
      setSaveState({ kind: "saved" });
      onSaved(title);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed unexpectedly.";
      setSaveState({ kind: "error", message });
    }
  }

  return (
    <div>
      <p className="mb-2 rounded-lg border border-hairline bg-surface-strong px-3 py-2 text-xs text-fg-muted">
        This editor round-trips its own markdown — reopening and saving content it originally wrote is lossless. Content written elsewhere (footnotes, raw HTML, and
        table cell line breaks especially) may come out reformatted the first time you save it here.
      </p>
      <label className="mb-1 block text-xs font-medium text-fg-muted" htmlFor={`title-${node.id}`}>
        Title
      </label>
      <input
        id={`title-${node.id}`}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="mb-2 w-full rounded-lg border border-hairline bg-surface-strong px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="rounded-lg border border-hairline bg-surface-strong/60 px-2 py-1.5">
        <MarkdownEditor
          key={node.id}
          initialContent={node.content}
          editable={true}
          onReady={(fn) => setGetMarkdown(() => fn)}
          ariaLabel={`${node.title || "(untitled)"} content, editable`}
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saveState.kind === "saving"}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-slate-950 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        >
          {saveState.kind === "saving" ? "Saving…" : "Save"}
        </button>
        {saveState.kind === "saved" && <span className="text-xs text-emerald-400">Saved.</span>}
        {saveState.kind === "error" && <span className="text-xs text-red-400">{saveState.message}</span>}
      </div>
    </div>
  );
}

function AnnotateSection({ target, onAnnotated }: { target: GraphNode; onAnnotated: (result: AnnotateResult, title: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [getMarkdown, setGetMarkdown] = useState<(() => string) | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string }>({ kind: "idle" });

  async function handleAnnotate() {
    setState({ kind: "saving" });
    try {
      const content = getMarkdown ? getMarkdown() : undefined;
      const result = await trpc.annotateNode.mutate({ targetNodeId: target.id, title: title.trim() || undefined, content });
      setState({ kind: "idle" });
      setOpen(false);
      setTitle("");
      onAnnotated(result, title.trim() || undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Annotation failed unexpectedly.";
      setState({ kind: "error", message });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
      >
        + Annotate this node
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-hairline p-2">
      <p className="mb-2 text-xs text-fg-muted">
        Creates a separate note linked to this node by an <code>annotates</code> edge — this node's own content is never changed. Permitted on any node, including
        read-only ones.
      </p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note title (optional)"
        className="mb-2 w-full rounded-lg border border-hairline bg-surface-strong px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="rounded-lg border border-hairline bg-surface-strong/60 px-2 py-1.5">
        <MarkdownEditor initialContent="" editable={true} onReady={(fn) => setGetMarkdown(() => fn)} ariaLabel="Annotation content" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleAnnotate()}
          disabled={state.kind === "saving"}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-slate-950 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        >
          {state.kind === "saving" ? "Annotating…" : "Add annotation"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-fg-muted hover:text-fg hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
          Cancel
        </button>
        {state.kind === "error" && <span className="text-xs text-red-400">{state.message}</span>}
      </div>
    </div>
  );
}

function EdgeRow({
  nodeTitleById,
  view,
  onRetracted,
  onReweighted,
}: {
  nodeTitleById: (id: string) => string;
  view: ReturnType<typeof edgesTouchingNode>[number];
  onRetracted: () => void;
  onReweighted: (weight: number) => void;
}) {
  const [weight, setWeight] = useState(view.link.weight);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const arrow = view.direction === "outgoing" ? "→" : "←";

  // Edge identity for the write calls below is always `link.source`/
  // `.target` (normalized via `endpointId` — see nodeEdges.ts's header on
  // why they may already be resolved node objects, not id strings) —
  // `view.direction` only decides the arrow/label above, never which end
  // is src vs. dst.
  const srcId = endpointId(view.link.source);
  const dstId = endpointId(view.link.target);

  async function handleRetract() {
    setBusy(true);
    setError(null);
    try {
      await trpc.retractEdge.mutate({ srcId, dstId, edgeType: view.link.edgeType });
      onRetracted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retract failed unexpectedly.");
      setBusy(false);
    }
  }

  async function handleReweight() {
    setBusy(true);
    setError(null);
    try {
      await trpc.reweightEdge.mutate({ srcId, dstId, edgeType: view.link.edgeType, weight });
      onReweighted(weight);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reweight failed unexpectedly.");
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-hairline px-2 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg">
          {arrow} <span className="font-medium">{view.link.edgeType}</span> {nodeTitleById(view.otherNodeId)}
        </span>
        <span className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">{view.link.sourceSystem}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={weight}
          onChange={(e) => setWeight(Number(e.target.value))}
          disabled={!view.canRetract || busy}
          className="w-16 rounded border border-hairline bg-surface-strong px-1 py-0.5 text-xs text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:text-fg-muted"
        />
        {view.canRetract ? (
          <>
            <button
              type="button"
              onClick={() => void handleReweight()}
              disabled={busy}
              className="text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              Reweight
            </button>
            <button
              type="button"
              onClick={() => void handleRetract()}
              disabled={busy}
              className="text-red-400 hover:underline focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
            >
              Retract
            </button>
          </>
        ) : (
          <span className="text-fg-muted">not hand-authored — can't be retracted here</span>
        )}
      </div>
      {error && <p className="mt-1 text-red-400">{error}</p>}
    </li>
  );
}

function ConnectForm({ selfId, allNodes, onAsserted }: { selfId: string; allNodes: readonly GraphNode[]; onAsserted: (input: { srcId: string; dstId: string; edgeType: string; weight?: number }, result: AssertResult) => void }) {
  const targets = allNodes.filter((n) => n.id !== selfId);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [direction, setDirection] = useState<"outgoing" | "incoming">("outgoing");
  const [edgeType, setEdgeType] = useState("relates-to");
  const [weight, setWeight] = useState(1);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string }>({ kind: "idle" });

  if (targets.length === 0) {
    return <p className="text-xs text-fg-muted">No other nodes are on screen yet to connect to — search or expand to bring more in.</p>;
  }

  async function handleAssert() {
    if (!targetId || !edgeType.trim()) return;
    setState({ kind: "saving" });
    const input = direction === "outgoing" ? { srcId: selfId, dstId: targetId, edgeType: edgeType.trim(), weight } : { srcId: targetId, dstId: selfId, edgeType: edgeType.trim(), weight };
    try {
      const result = await trpc.assertEdge.mutate(input);
      setState({ kind: "idle" });
      onAsserted(input, result);
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Assert failed unexpectedly." });
    }
  }

  return (
    <div className="rounded-lg border border-hairline p-2 text-xs">
      <div className="flex items-center gap-1">
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as "outgoing" | "incoming")}
          className="rounded border border-hairline bg-surface-strong px-1 py-1 text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="outgoing">this →</option>
          <option value="incoming">this ←</option>
        </select>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="flex-1 rounded border border-hairline bg-surface-strong px-1 py-1 text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {targets.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title || "(untitled)"}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input
          type="text"
          value={edgeType}
          onChange={(e) => setEdgeType(e.target.value)}
          placeholder="relationship type"
          className="flex-1 rounded border border-hairline bg-surface-strong px-1 py-1 text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={weight}
          onChange={(e) => setWeight(Number(e.target.value))}
          className="w-16 rounded border border-hairline bg-surface-strong px-1 py-1 text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleAssert()}
          disabled={state.kind === "saving"}
          className="rounded bg-accent px-2 py-1 font-medium text-slate-950 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        >
          {state.kind === "saving" ? "Connecting…" : "Assert edge"}
        </button>
        {state.kind === "error" && <span className="text-red-400">{state.message}</span>}
      </div>
    </div>
  );
}

export function DetailPanel({ nodeId, allNodes, allLinks, onClose, onExpandedChange, onContentSaved, onAnnotated, onEdgeAsserted, onEdgeRetracted, onEdgeReweighted, defaultView, onOpenDefaultView }: DetailPanelProps) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  // bd-e9n, design.md decision 6 — see this file's header. Defaults to
  // "summary" on every mount (a fresh `nodeId`, per App.tsx's `key`).
  const [panelState, setPanelState] = useState<"summary" | "expanded">("summary");
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Captured on open, read on close — see `handleClose` below and this
  // file's header (bd-8ub review, should-fix 6).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);

  /**
   * Toggles between summary and expanded, reporting the new state up
   * (`onExpandedChange`'s own doc comment) — never called on mount, only
   * from the "Show more"/"Show less" button below.
   *
   * `next` is computed from `panelState` here in the closure, and both
   * setters are called from this plain event-handler body — NOT from
   * inside `setPanelState`'s updater form. React invokes a `useState`
   * updater during ITS OWN component's render (StrictMode double-invokes
   * it specifically to catch this), so calling `onExpandedChange` (App's
   * `setDetailExpanded`) from inside one is a call into a DIFFERENT
   * component's setter while THIS component is rendering — exactly
   * React's "Cannot update a component (App) while rendering a different
   * component (DetailPanel)" warning. Plain sequential calls here run in
   * the click handler, not in any render, so neither setter call is ever
   * mid-render.
   */
  function toggleExpanded() {
    const next = panelState === "summary" ? "expanded" : "summary";
    setPanelState(next);
    onExpandedChange?.(next === "expanded");
  }

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    trpc.getNodes
      .query({ ids: [nodeId] })
      .then((result) => {
        if (cancelled) return;
        const node = result.nodes[0];
        if (!node) {
          setState({ kind: "error", message: "This node could not be found — it may have been merged or removed." });
          return;
        }
        setState({ kind: "ready", node });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : "Failed to load this node." });
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  // Focus management on open (bd-8ub review, should-fix 6): capture
  // whatever had focus right before this panel appeared, then move focus
  // to the panel's own heading — the panel becoming an overlay (see this
  // file's header) means nothing about the page's layout already puts
  // focus somewhere reasonable inside it the way a layout-flow region
  // might.
  useEffect(() => {
    // StrictMode runs this effect twice on mount; by the second pass focus
    // already sits on our own heading, and recording that would make the
    // restore-on-close a no-op (round-2 review). Only capture focus that
    // lives outside the panel.
    const active = document.activeElement;
    const insidePanel = asideRef.current?.contains(active) ?? false;
    if (active instanceof HTMLElement && !insidePanel) {
      previouslyFocusedRef.current = active;
    }
    headingRef.current?.focus();
  }, [nodeId]);

  // Focus restore on UNMOUNT (url-addressable-views review follow-up).
  // `handleClose` below only covers the × button and Escape; every other
  // way this panel goes away — a back/forward step that `applyRoute`
  // turns into `setSelectedNodeId(null)`, a fresh search landing, a note
  // being created while this one is open — removes it through App.tsx's
  // `{selectedNodeId && …}` guard with focus still on the heading (or a
  // control inside), and a browser resets `document.activeElement` to
  // `<body>` the instant a focused element is detached. If focus is
  // inside the panel as it unmounts, hand it to the same fallbacks
  // `handleClose` uses (the captured opener is deliberately NOT tried
  // here: on a popstate it is whatever the person last clicked, which may
  // itself be gone). `handleClose`'s own explicit restore stays — by the
  // time this cleanup runs its target already has focus, so this pass
  // sees focus outside the panel and does nothing.
  //
  // `useLayoutEffect`, not `useEffect`, and the `<aside>` captured at
  // mount rather than read from the ref: React runs LAYOUT cleanups for
  // a deleted subtree during its deletion traversal, before the host
  // node is removed from the document, whereas passive (`useEffect`)
  // cleanups run after — by which point the aside is detached, its ref
  // is null, and `activeElement` is already `<body>`, so the check below
  // could never be true.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    return () => {
      if (!aside || !aside.contains(document.activeElement)) return;
      const fallback =
        document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR) ?? document.querySelector<HTMLElement>(CANVAS_CONTAINER_SELECTOR);
      fallback?.focus();
    };
  }, []);

  /**
   * Routes both close affordances (the × button and Escape below) through
   * one place, so "restore focus on close" (bd-8ub review, should-fix 6)
   * can't be forgotten on one path — restores focus to whatever was
   * captured on open if it's still a real restoration target, otherwise
   * the search input, otherwise the canvas.
   *
   * bd-e9n review: the "still in the document" check used to be
   * `document.body.contains(previous)` alone, which is true for
   * `document.body` itself (`Node.contains` includes the node it's
   * called on) — so switching straight from one selected node's panel to
   * another's, with focus inside the FIRST panel (e.g. "Show more"), let
   * `previous` capture `document.body`: the new panel's own
   * focus-capture effect runs after the old panel's focused element has
   * already been removed from the DOM, and a browser resets
   * `document.activeElement` to `body` the instant a focused element is
   * detached — before that effect ever gets to read it. `body.contains(body)`
   * then passed the old check, so `previous.focus()` called `body.focus()`,
   * a no-op (body isn't focusable), which is exactly "Escape drops focus
   * to `<body>`." Excluding `document.body` explicitly closes that gap;
   * the canvas container is a new second fallback for the case the
   * search input itself can't be found either, so this never bottoms out
   * on `<body>` by omission.
   */
  function handleClose() {
    const previous = previouslyFocusedRef.current;
    if (previous && previous !== document.body && document.body.contains(previous)) {
      previous.focus();
    } else {
      const fallback =
        document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR) ?? document.querySelector<HTMLElement>(CANVAS_CONTAINER_SELECTOR);
      fallback?.focus();
    }
    onClose();
  }

  const graphNode = allNodes.find((n) => n.id === nodeId);
  const edgeViews = edgesTouchingNode(allLinks, nodeId);
  const nodeTitleById = (id: string) => allNodes.find((n) => n.id === id)?.title || id.slice(0, 8);
  // node-views/spec.md, "A node's preferred view is offered, never forced":
  // a `feed`, `code`, or `timeline` renderer earns the affordance, named
  // for the renderer — see `defaultView`'s doc.
  const offer = defaultView?.view && isOfferedRenderer(defaultView.view.renderer) ? { id: defaultView.view.id, renderer: defaultView.view.renderer, title: defaultView.view.title } : null;

  return (
    <aside
      ref={asideRef}
      role="complementary"
      aria-label="Node detail"
      // bd-e9n, design.md decision 6: w-80 in summary (needs less room
      // than an editor), w-96 once expanded — the canvas itself stays
      // full-bleed regardless (GraphCanvas.tsx never reads this), only
      // App.tsx's `insetRight` (via `onExpandedChange`) follows it.
      className={`glass flex h-full ${panelState === "expanded" ? "w-96" : "w-80"} flex-col overflow-y-auto p-4`}
      // bd-bxr: the panel is now a floating overlay with no implicit
      // click-away boundary — Escape is the keyboard-accessible
      // equivalent of the explicit close button below.
      //
      // bd-8ub review, must-fix 2: scoped to this panel's own `onKeyDown`
      // (not a `window` listener) and target-checked — Escape while
      // typing in one of this panel's own editable elements (an input, a
      // select, or the MarkdownEditor's contenteditable) blurs THAT
      // element instead of closing the whole panel and discarding the
      // edit; Escape anywhere else in the panel closes it as before.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        const editable = closestEditable(e.target);
        if (editable) {
          editable.blur();
          return;
        }
        handleClose();
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-fg focus:outline-none">
          {graphNode?.title || (state.kind === "ready" ? state.node.title : "Node")}
        </h2>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close node detail"
          className="rounded px-2 py-1 text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          ×
        </button>
      </div>

      {graphNode && (
        <div className="mb-3 space-y-1 rounded-lg border border-hairline bg-surface-strong p-2">
          <InfoRow label="type" value={graphNode.nodeType} />
          <InfoRow label="source" value={graphNode.sourceSystem} />
          <InfoRow label="degree" value={String(graphNode.degree)} />
        </div>
      )}

      {offer && onOpenDefaultView && (
        <button
          type="button"
          onClick={() => onOpenDefaultView({ id: offer.id, renderer: offer.renderer })}
          className="mb-3 w-full truncate rounded-lg border border-hairline px-3 py-1.5 text-left text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Open as {offer.renderer} · {offer.title || "(untitled view)"}
        </button>
      )}

      {state.kind === "loading" && <p className="text-xs text-fg-muted">Loading…</p>}
      {state.kind === "error" && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          {/*
            bd-e9n, design.md decision 6: summary shows only this excerpt
            — no editor, no annotate/edge controls (those, and the
            ability to edit at all, are reachable only once expanded).
            Plain text, not markdown-rendered — see this file's header on
            why a full editor instance is more than a one-paragraph
            excerpt needs; JSX text content already escapes it safely.
          */}
          {panelState === "summary" && <p className="mb-3 text-sm text-fg">{firstParagraph(state.node.content) || "No content yet."}</p>}

          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={panelState === "expanded"}
            className="mb-4 rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {panelState === "summary" ? "Show more" : "Show less"}
          </button>

          {panelState === "expanded" && (
            <>
              <section className="mb-4">
                <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">Content</h3>
                <ContentSection node={state.node} onSaved={(title) => onContentSaved(nodeId, title)} />
              </section>

              <section className="mb-4">
                <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">Annotate</h3>
                {graphNode && <AnnotateSection target={graphNode} onAnnotated={(result, title) => graphNode && onAnnotated(graphNode, result, title)} />}
              </section>

              <section>
                <h3 className="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">Edges ({edgeViews.length})</h3>
                <ul className="mb-2 space-y-1.5">
                  {edgeViews.map((view) => (
                    <EdgeRow
                      key={view.link.id}
                      view={view}
                      nodeTitleById={nodeTitleById}
                      onRetracted={() => onEdgeRetracted(view.link.id)}
                      onReweighted={(weight) => onEdgeReweighted(view.link.id, weight)}
                    />
                  ))}
                  {edgeViews.length === 0 && <p className="text-xs text-fg-muted">No edges drawn for this node yet.</p>}
                </ul>
                <ConnectForm selfId={nodeId} allNodes={allNodes} onAsserted={onEdgeAsserted} />
              </section>
            </>
          )}
        </>
      )}

      <p className="mt-4 text-[10px] text-fg-muted/70">source system for hand-authored writes: {HUMAN_SOURCE_SYSTEM}</p>
    </aside>
  );
}
