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
// element if it's still in the document, or to the search input
// otherwise (its `aria-label` is this file's own lookup key, deliberately
// not a new prop threaded down from App.tsx — see `handleClose`'s
// comment).

import { useEffect, useRef, useState } from "react";
import { HUMAN_SOURCE_SYSTEM } from "../graph/expansion.js";
import type { GraphLink, GraphNode } from "../graph/encoding.js";
import { edgesTouchingNode, endpointId } from "../graph/nodeEdges.js";
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
  /** A content/title edit was saved — App.tsx patches the canvas node's own title (graph/expansion.ts's `mergeNodePatch`). */
  onContentSaved: (nodeId: string, newTitle: string) => void;
  /** An annotation was created — App.tsx draws the note and its edge via `mergeExpansion` (task 6.3's required reuse). */
  onAnnotated: (target: GraphNode, result: AnnotateResult, title: string | undefined) => void;
  /** A hand edge was asserted between this node and another already-drawn node. */
  onEdgeAsserted: (input: { srcId: string; dstId: string; edgeType: string; weight?: number }, result: AssertResult) => void;
  onEdgeRetracted: (linkId: string) => void;
  onEdgeReweighted: (linkId: string, weight: number) => void;
}

/** Closest editable ancestor of `target` (inclusive), if any — an `input`/`textarea`/`select`, or a `[contenteditable="true"]` region (the MarkdownEditor). Escape inside one of these must blur it, not close the whole panel (bd-8ub review, must-fix 2). */
function closestEditable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const editable = target.closest('input, textarea, select, [contenteditable="true"]');
  return editable instanceof HTMLElement ? editable : null;
}

/** App.tsx's SearchBar renders the one search input this whole app has, tagged with this exact `aria-label` — the fallback focus target when a panel closes and whatever was focused before it opened is gone (bd-8ub review, should-fix 6). A selector, not a new prop: threading a ref down from App.tsx for a single fallback lookup would be more surface for the same one-line answer. */
const SEARCH_INPUT_SELECTOR = 'input[aria-label="Search the knowledge store"]';

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

export function DetailPanel({ nodeId, allNodes, allLinks, onClose, onContentSaved, onAnnotated, onEdgeAsserted, onEdgeRetracted, onEdgeReweighted }: DetailPanelProps) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Captured on open, read on close — see `handleClose` below and this
  // file's header (bd-8ub review, should-fix 6).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

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
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
  }, [nodeId]);

  /**
   * Routes both close affordances (the × button and Escape below) through
   * one place, so "restore focus on close" (bd-8ub review, should-fix 6)
   * can't be forgotten on one path — restores focus to whatever was
   * captured on open if it's still in the document, otherwise to the
   * search input (SEARCH_INPUT_SELECTOR's own comment).
   */
  function handleClose() {
    const previous = previouslyFocusedRef.current;
    if (previous && document.body.contains(previous)) {
      previous.focus();
    } else {
      document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR)?.focus();
    }
    onClose();
  }

  const graphNode = allNodes.find((n) => n.id === nodeId);
  const edgeViews = edgesTouchingNode(allLinks, nodeId);
  const nodeTitleById = (id: string) => allNodes.find((n) => n.id === id)?.title || id.slice(0, 8);

  return (
    <aside
      role="complementary"
      aria-label="Node detail"
      className="glass flex h-full w-96 flex-col overflow-y-auto p-4"
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

      {state.kind === "loading" && <p className="text-xs text-fg-muted">Loading…</p>}
      {state.kind === "error" && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">{state.message}</p>}
      {state.kind === "ready" && (
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

      <p className="mt-4 text-[10px] text-fg-muted/70">source system for hand-authored writes: {HUMAN_SOURCE_SYSTEM}</p>
    </aside>
  );
}
