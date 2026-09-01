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

import { useEffect, useState } from "react";
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
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-700">{value}</span>
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
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
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
      <p className="mb-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        This editor round-trips its own markdown — reopening and saving content it originally wrote is lossless. Content written elsewhere (footnotes, raw HTML, and
        table cell line breaks especially) may come out reformatted the first time you save it here.
      </p>
      <label className="mb-1 block text-xs font-medium text-slate-500" htmlFor={`title-${node.id}`}>
        Title
      </label>
      <input
        id={`title-${node.id}`}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <div className="rounded border border-slate-300 px-2 py-1.5">
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
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saveState.kind === "saving" ? "Saving…" : "Save"}
        </button>
        {saveState.kind === "saved" && <span className="text-xs text-emerald-700">Saved.</span>}
        {saveState.kind === "error" && <span className="text-xs text-red-700">{saveState.message}</span>}
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
      <button type="button" onClick={() => setOpen(true)} className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
        + Annotate this node
      </button>
    );
  }

  return (
    <div className="rounded border border-slate-300 p-2">
      <p className="mb-2 text-xs text-slate-500">
        Creates a separate note linked to this node by an <code>annotates</code> edge — this node's own content is never changed. Permitted on any node, including
        read-only ones.
      </p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note title (optional)"
        className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <div className="rounded border border-slate-300 px-2 py-1.5">
        <MarkdownEditor initialContent="" editable={true} onReady={(fn) => setGetMarkdown(() => fn)} ariaLabel="Annotation content" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleAnnotate()}
          disabled={state.kind === "saving"}
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {state.kind === "saving" ? "Annotating…" : "Add annotation"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:underline">
          Cancel
        </button>
        {state.kind === "error" && <span className="text-xs text-red-700">{state.message}</span>}
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
    <li className="rounded border border-slate-200 px-2 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span>
          {arrow} <span className="font-medium">{view.link.edgeType}</span> {nodeTitleById(view.otherNodeId)}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{view.link.sourceSystem}</span>
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
          className="w-16 rounded border border-slate-300 px-1 py-0.5 text-xs disabled:bg-slate-50 disabled:text-slate-400"
        />
        {view.canRetract ? (
          <>
            <button type="button" onClick={() => void handleReweight()} disabled={busy} className="text-indigo-700 hover:underline disabled:opacity-50">
              Reweight
            </button>
            <button type="button" onClick={() => void handleRetract()} disabled={busy} className="text-red-700 hover:underline disabled:opacity-50">
              Retract
            </button>
          </>
        ) : (
          <span className="text-slate-400">not hand-authored — can't be retracted here</span>
        )}
      </div>
      {error && <p className="mt-1 text-red-700">{error}</p>}
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
    return <p className="text-xs text-slate-400">No other nodes are on screen yet to connect to — search or expand to bring more in.</p>;
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
    <div className="rounded border border-slate-300 p-2 text-xs">
      <div className="flex items-center gap-1">
        <select value={direction} onChange={(e) => setDirection(e.target.value as "outgoing" | "incoming")} className="rounded border border-slate-300 px-1 py-1">
          <option value="outgoing">this →</option>
          <option value="incoming">this ←</option>
        </select>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="flex-1 rounded border border-slate-300 px-1 py-1">
          {targets.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title || "(untitled)"}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input type="text" value={edgeType} onChange={(e) => setEdgeType(e.target.value)} placeholder="relationship type" className="flex-1 rounded border border-slate-300 px-1 py-1" />
        <input type="number" min={0} max={1} step={0.05} value={weight} onChange={(e) => setWeight(Number(e.target.value))} className="w-16 rounded border border-slate-300 px-1 py-1" />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button type="button" onClick={() => void handleAssert()} disabled={state.kind === "saving"} className="rounded bg-slate-900 px-2 py-1 font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {state.kind === "saving" ? "Connecting…" : "Assert edge"}
        </button>
        {state.kind === "error" && <span className="text-red-700">{state.message}</span>}
      </div>
    </div>
  );
}

export function DetailPanel({ nodeId, allNodes, allLinks, onClose, onContentSaved, onAnnotated, onEdgeAsserted, onEdgeRetracted, onEdgeReweighted }: DetailPanelProps) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });

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

  const graphNode = allNodes.find((n) => n.id === nodeId);
  const edgeViews = edgesTouchingNode(allLinks, nodeId);
  const nodeTitleById = (id: string) => allNodes.find((n) => n.id === id)?.title || id.slice(0, 8);

  return (
    <aside role="complementary" aria-label="Node detail" className="flex h-full w-96 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{graphNode?.title || (state.kind === "ready" ? state.node.title : "Node")}</h2>
        <button type="button" onClick={onClose} aria-label="Close node detail" className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          ×
        </button>
      </div>

      {graphNode && (
        <div className="mb-3 space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
          <InfoRow label="type" value={graphNode.nodeType} />
          <InfoRow label="source" value={graphNode.sourceSystem} />
          <InfoRow label="degree" value={String(graphNode.degree)} />
        </div>
      )}

      {state.kind === "loading" && <p className="text-xs text-slate-400">Loading…</p>}
      {state.kind === "error" && <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Content</h3>
            <ContentSection node={state.node} onSaved={(title) => onContentSaved(nodeId, title)} />
          </section>

          <section className="mb-4">
            <h3 className="mb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Annotate</h3>
            {graphNode && <AnnotateSection target={graphNode} onAnnotated={(result, title) => graphNode && onAnnotated(graphNode, result, title)} />}
          </section>

          <section>
            <h3 className="mb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">Edges ({edgeViews.length})</h3>
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
              {edgeViews.length === 0 && <p className="text-xs text-slate-400">No edges drawn for this node yet.</p>}
            </ul>
            <ConnectForm selfId={nodeId} allNodes={allNodes} onAsserted={onEdgeAsserted} />
          </section>
        </>
      )}

      <p className="mt-4 text-[10px] text-slate-300">source system for hand-authored writes: {HUMAN_SOURCE_SYSTEM}</p>
    </aside>
  );
}
