// The code view (code-view, design.md decisions 3, 4, and 6): a `view`
// node's roots drawn as a file tree on the left, the node the address
// names on the right — a `file` read-only in CodeMirror with line numbers
// and the grammar its `language` names, a `directory` as its listing,
// anything else as preformatted text. Mounted by the shell (App.tsx)
// under `/code`, addressed by `?view=<id>&node=<id>` (lib/route.ts), and
// read-only: nothing here writes to the store.
//
// Reads. The view loads exactly as the feed does (design.md decision 3):
// `getNodes` for the view node, `viewFilterOf` (lib/viewFilter.ts, shared)
// for its filter, then `list` with the filter spread in plus a page size
// for the roots. The renderer is not checked — `/code` draws any view's
// selection as a tree, and every root is expandable whatever its type
// (`isExpandable`, lib/codeTree.ts: an epic's `child_of` work items draw
// the same as a repo's directories); one without children opens to
// nothing. One root is expanded to its first level and its `tree` read
// issued at once; several are collapsed, each read on first expansion. A
// `tree` answer is cached in state by root id for the life of the view (a
// view change resets the cache; the ready state carries `forViewId`, and
// the tree-read effect and `ownerOf` bail while it lags `viewId`, so a
// render still holding the old view never reads under the new one). With
// `node` set, `getNodes([node])` runs in parallel
// with the roots: the node's external id up to the first `:` is the
// loader's key, which is the root's own external id (`rootKeyOf`, lib/
// codeTree.ts), so the owning root is known without a walk and its tree
// is read; the ancestors are then followed client-side through `parentId`
// (`ancestorsOf`) and expanded. A node no loaded tree contains — another
// source's node, a truncated tree — is the "not in this view" state, and
// the address stays.
//
// Navigation. Activating an entry pushes `{ view: "code", viewId, node }`
// (design.md decision 2: a file is a document, so back returns to the
// previous file); "Open in graph" pushes `{ view: "graph", node }`. Both
// are synchronous responses to a click — this view never navigates after
// an `await`, so it needs no `leaveView` guard of GraphView's kind: a
// stale answer is dropped by the `cancelled` flag of the effect that
// asked for it (the feed's pattern) or by the generation the tree read
// captured, and neither path writes history.
//
// Expansion is derived from the address plus what the person toggles
// (design.md Non-Goals): whenever the shown node's owner tree is known,
// its ancestors (and the node itself when it is a container — "Activating
// a directory SHALL also expand it") are added to the expanded set, never
// removed, so a deep link, an activation, and a back step all bring the
// selected node into view without collapsing what the person opened.
//
// The empty states — no view, not a view, node not in this view — each
// keep the address with a way to the graph (code-view/spec.md, "The code
// view is addressable"); `/code?view=abc` parses and `getNodes` rejects
// the id with BAD_REQUEST, read as "names no view" the way the feed reads
// it. User copy never repeats a raw id: it is in the address bar.

import { LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";
import { TRPCClientError } from "@trpc/client";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { loadLanguage } from "../lib/codeLanguage.js";
import { ancestorsOf, buildTree, childrenOf, isContainer, isExpandable, rootKeyOf, type CodeTree, type TreeRow } from "../lib/codeTree.js";
import { navigate } from "../lib/navigate.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { viewFilterOf } from "../lib/viewFilter.js";
import { trpc } from "../trpc.js";
import { ReviewQueuePill } from "./ReviewQueue.js";

type ListResult = Awaited<ReturnType<typeof trpc.list.query>>;
type RootRow = ListResult["nodes"][number];
type LookedUpNode = Awaited<ReturnType<typeof trpc.getNodes.query>>["nodes"][number];

/** Roots per `list` call — design.md decision 3. No "load more": the header says how many are shown. */
const ROOT_PAGE_SIZE = 50;

/** The bare graph — no search, nothing selected — which is where "Open the graph" goes. */
const GRAPH_HOME: GraphRoute = { view: "graph", q: null, types: [], node: null };

/** `forViewId` is the address the ready state was loaded for: a render can still hold the previous view's state after `viewId` changed, and anything that reads the store from it must wait for the reload. */
type ViewState =
  | { kind: "no-view" }
  | { kind: "loading" }
  | { kind: "not-a-view" }
  | { kind: "error"; message: string }
  | { kind: "ready"; forViewId: string; view: { id: string; title: string }; roots: RootRow[]; hasMore: boolean };

type TreeState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; tree: CodeTree; truncated: boolean };

/** The node the address names, as `getNodes` answered: `missing` for BAD_REQUEST or an empty answer (no such node). */
type NodeState = { kind: "none" } | { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready"; node: LookedUpNode };

/** Which loaded tree holds the shown node — `pending` while a candidate root's tree is still on its way, `error` when a candidate's read failed (the message is the tree's), `outside` when none holds it. */
type Owner = { kind: "none" } | { kind: "pending" } | { kind: "error"; message: string } | { kind: "outside" } | { kind: "found"; rootId: string; tree: CodeTree };

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data?.code === "BAD_REQUEST";
}

function messageOf(err: unknown, fallback: string): string {
  // TRPCClientError#message is already the safe, hand-mapped message
  // server/errors.ts built — never a stack trace or connection string.
  return err instanceof Error ? err.message : fallback;
}

/** `metadata.<key>` as text, or `null` — the loader writes `path` and `language` as strings; anything else is treated as absent. */
function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

/** A root as the tree pane draws it before (or without) its `tree` answer: the `list` row in `TreeRow` shape. */
function rootRowOf(root: RootRow): TreeRow {
  return {
    id: root.id,
    parentId: null,
    nodeType: root.nodeType,
    title: root.title,
    externalId: root.externalId,
    path: metadataText(root.metadata, "path"),
    language: metadataText(root.metadata, "language"),
  };
}

/** Which loaded tree holds `nodeId` — see `Owner`. Any ready tree is searched first; only then does a candidate root (same loader key) still loading make the answer `pending`, or one whose read failed `error`. A ready view loaded for another address is still `pending`: its trees are the old view's. */
function ownerOf(view: ViewState, viewId: string | null, trees: ReadonlyMap<string, TreeState>, shown: NodeState, nodeId: string | null): Owner {
  if (nodeId === null) {
    return { kind: "none" };
  }
  if (view.kind !== "ready" || view.forViewId !== viewId) {
    return { kind: "pending" };
  }
  for (const root of view.roots) {
    const state = trees.get(root.id);
    if (state?.kind === "ready" && state.tree.rows.has(nodeId)) {
      return { kind: "found", rootId: root.id, tree: state.tree };
    }
  }
  if (shown.kind === "loading") {
    return { kind: "pending" };
  }
  if (shown.kind !== "ready") {
    return { kind: "outside" };
  }
  const key = rootKeyOf(shown.node.externalId);
  let failed: string | null = null;
  for (const root of view.roots) {
    if (rootKeyOf(root.externalId) !== key) {
      continue;
    }
    const state = trees.get(root.id);
    if (state === undefined || state.kind === "loading") {
      return { kind: "pending" };
    }
    if (state.kind === "error") {
      failed = state.message;
    }
  }
  return failed === null ? { kind: "outside" } : { kind: "error", message: failed };
}

export function CodeView({ viewId, node }: { viewId: string | null; node: string | null }) {
  const [view, setView] = useState<ViewState>(viewId === null ? { kind: "no-view" } : { kind: "loading" });
  const [trees, setTrees] = useState<ReadonlyMap<string, TreeState>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<NodeState>(node === null ? { kind: "none" } : { kind: "loading" });
  // Bumped whenever the view (re)loads; a `tree` answer carrying an older
  // generation belongs to a view no longer shown and is dropped. The
  // requested set keeps one read per root per generation.
  const generation = useRef(0);
  const requested = useRef(new Set<string>());

  // The view and its roots, keyed on `viewId`: the shell re-renders this
  // component with a new id when the address changes view (same `key`,
  // so no remount); the `cancelled` flag drops a stale answer the way
  // FeedView's effect does. Everything derived from the view — the tree
  // cache, the expansion set — starts over with it.
  useEffect(() => {
    generation.current += 1;
    requested.current = new Set();
    setTrees(new Map());
    setExpanded(new Set());
    if (viewId === null) {
      setView({ kind: "no-view" });
      return;
    }
    let cancelled = false;
    setView({ kind: "loading" });

    async function load(id: string) {
      let viewNode: LookedUpNode | undefined;
      try {
        const lookup = await trpc.getNodes.query({ ids: [id] });
        viewNode = lookup.nodes[0];
      } catch (err) {
        if (cancelled) return;
        setView(isBadRequest(err) ? { kind: "not-a-view" } : { kind: "error", message: messageOf(err, "Failed to load this view.") });
        return;
      }
      if (cancelled) return;
      const filter = viewNode ? viewFilterOf(viewNode) : null;
      if (!viewNode || filter === null) {
        setView({ kind: "not-a-view" });
        return;
      }
      try {
        const page = await trpc.list.query({ ...filter, limit: ROOT_PAGE_SIZE });
        if (cancelled) return;
        // One root is opened at once (design.md decision 3); several stay
        // collapsed until the person expands one.
        const only = page.nodes.length === 1 ? page.nodes[0] : undefined;
        if (only !== undefined) {
          setExpanded(new Set([only.id]));
        }
        setView({ kind: "ready", forViewId: id, view: { id: viewNode.id, title: viewNode.title }, roots: page.nodes, hasMore: page.hasMore });
      } catch (err) {
        if (cancelled) return;
        setView({ kind: "error", message: messageOf(err, "Failed to list this view's roots.") });
      }
    }

    void load(viewId);
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  // The shown node, keyed on `node`: read in parallel with the view on a
  // deep link, and again on every activation (the content is what the
  // pane draws; the tree holds structure only).
  useEffect(() => {
    if (node === null) {
      setShown({ kind: "none" });
      return;
    }
    let cancelled = false;
    setShown({ kind: "loading" });

    async function load(id: string) {
      try {
        const lookup = await trpc.getNodes.query({ ids: [id] });
        if (cancelled) return;
        const found = lookup.nodes[0];
        setShown(found ? { kind: "ready", node: found } : { kind: "missing" });
      } catch (err) {
        if (cancelled) return;
        setShown(isBadRequest(err) ? { kind: "missing" } : { kind: "error", message: messageOf(err, "Failed to load this node.") });
      }
    }

    void load(node);
    return () => {
      cancelled = true;
    };
  }, [node]);

  /** One `tree` read per root per view; the answer is cached by root id. An answer landing after the view changed is dropped. */
  async function loadTree(rootId: string) {
    requested.current.add(rootId);
    const issuedFor = generation.current;
    setTrees((previous) => new Map(previous).set(rootId, { kind: "loading" }));
    try {
      const answer = await trpc.tree.query({ rootId });
      if (issuedFor !== generation.current) return;
      setTrees((previous) => new Map(previous).set(rootId, { kind: "ready", tree: buildTree(answer.nodes), truncated: answer.truncated }));
    } catch (err) {
      if (issuedFor !== generation.current) return;
      // Forgotten here so a retry is possible; the error state below keeps
      // the tree-read effect from re-issuing it until the person re-expands
      // the root (`toggle`), which drops the state.
      requested.current.delete(rootId);
      setTrees((previous) => new Map(previous).set(rootId, { kind: "error", message: messageOf(err, "Failed to read this tree.") }));
    }
  }

  // Which roots need their tree: the one root of a single-root view, any
  // root the person expanded, and — once the shown node is known — every
  // root sharing its loader key, so a deep link's owner is read without
  // waiting for an expansion. Runs after every render; `requested` makes
  // it idempotent, and a root whose read failed is left alone until the
  // person re-expands it. It bails while `view` is the previous address's:
  // the `viewId` effect above runs first in the same flush, bumping the
  // generation and emptying `requested`, so without this check the old
  // view's root would be read anew under the new generation and its
  // answer cached against the new view.
  useEffect(() => {
    if (view.kind !== "ready" || view.forViewId !== viewId) {
      return;
    }
    const wanted = new Set<string>();
    const only = view.roots.length === 1 ? view.roots[0] : undefined;
    if (only !== undefined) {
      wanted.add(only.id);
    }
    for (const root of view.roots) {
      if (expanded.has(root.id)) {
        wanted.add(root.id);
      }
    }
    if (shown.kind === "ready") {
      const key = rootKeyOf(shown.node.externalId);
      for (const root of view.roots) {
        if (rootKeyOf(root.externalId) === key) {
          wanted.add(root.id);
        }
      }
    }
    for (const rootId of wanted) {
      if (!requested.current.has(rootId) && trees.get(rootId)?.kind !== "error") {
        void loadTree(rootId);
      }
    }
  });

  const owner = ownerOf(view, viewId, trees, shown, node);
  const ownerTree = owner.kind === "found" ? owner.tree : null;

  // Expansion follows the address: the shown node's ancestors, and the
  // node itself when it is a container, are added once its owner tree is
  // known. Additive only — see the header.
  useEffect(() => {
    if (node === null || ownerTree === null) {
      return;
    }
    const chain = ancestorsOf(ownerTree, node);
    if (chain === null) {
      return;
    }
    const row = ownerTree.rows.get(node);
    const toExpand = row !== undefined && isExpandable(row) ? [...chain, node] : chain;
    setExpanded((previous) => {
      let next: Set<string> | null = null;
      for (const id of toExpand) {
        if (!previous.has(id)) {
          next ??= new Set(previous);
          next.add(id);
        }
      }
      return next ?? previous;
    });
  }, [node, ownerTree]);

  function toggle(id: string) {
    // Re-expanding a root whose `tree` read failed retries it: the error
    // state is dropped, and the tree-read effect issues the read again.
    if (!expanded.has(id) && trees.get(id)?.kind === "error") {
      setTrees((previous) => {
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  /** Entry activation (code-view/spec.md, "The tree pane"): a push, so the browser's back control returns to the previously opened node; a container (or a root) is expanded as well. */
  function activate(row: TreeRow) {
    if (isExpandable(row)) {
      setExpanded((previous) => (previous.has(row.id) ? previous : new Set(previous).add(row.id)));
    }
    navigate({ view: "code", viewId, node: row.id }, "push");
  }

  // A real `href` so the link is a link (middle-click, copy address); a
  // plain left click goes through `navigate` so the shell swaps views
  // without a page load, the way every in-app move does.
  function handleGraphLink(route: GraphRoute) {
    return (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(route, "push");
    };
  }

  if (view.kind !== "ready") {
    const copy =
      view.kind === "no-view"
        ? "No view is named in the address."
        : view.kind === "not-a-view"
          ? "The address does not name a view."
          : view.kind === "loading"
            ? "Loading…"
            : null;
    return (
      <main className="flex h-dvh w-screen items-center justify-center overflow-hidden">
        <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
        <div className="glass w-96 p-6">
          <h1 className="text-base font-semibold text-fg">Code</h1>
          {copy !== null && <p className="mt-2 text-sm text-fg-muted">{copy}</p>}
          {view.kind === "error" && (
            <p role="alert" className="mt-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {view.message}
            </p>
          )}
          <a href={formatRoute(GRAPH_HOME)} onClick={handleGraphLink(GRAPH_HOME)} className="mt-4 inline-block rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
            Open the graph
          </a>
        </div>
      </main>
    );
  }

  // The graph link names the shown node when there is one to name —
  // even one this view does not hold, since the graph can still draw it.
  const graphRoute: GraphRoute = shown.kind === "ready" ? { view: "graph", q: null, types: [], node: shown.node.id } : GRAPH_HOME;
  const shownRow = owner.kind === "found" && node !== null ? owner.tree.rows.get(node) : undefined;
  const path = shown.kind === "ready" ? (shownRow?.path ?? metadataText(shown.node.metadata, "path") ?? shown.node.title) : null;
  const rootsLine = `${view.roots.length} root${view.roots.length === 1 ? "" : "s"} shown${view.hasMore ? " · more match this view" : ""}`;
  // The pane's alert: the node's own read failing, or the read of the tree that would hold it.
  const paneError = shown.kind === "error" ? shown.message : owner.kind === "error" ? owner.message : null;

  return (
    <main className="flex h-dvh w-screen gap-3 overflow-hidden p-3">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />

      <nav aria-label="Tree" className="glass flex w-72 shrink-0 flex-col overflow-hidden">
        <p role="status" className="border-b border-hairline px-3 py-2 text-xs text-fg-muted">
          {view.roots.length === 0 ? "No nodes match this view." : rootsLine}
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          {view.roots.map((root) => (
            <RootEntry key={root.id} root={root} state={trees.get(root.id)} expanded={expanded} selectedId={node} onToggle={toggle} onActivate={activate} />
          ))}
        </ul>
      </nav>

      <section aria-label="File" className="glass flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-start justify-between gap-4 border-b border-hairline p-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{view.view.title || "(untitled view)"}</h1>
            {path !== null && (
              <h2 className="mt-0.5 truncate font-mono text-xs text-fg-muted" data-path={path}>
                {path}
              </h2>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
            <a href={formatRoute(graphRoute)} onClick={handleGraphLink(graphRoute)} className="shrink-0 rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent">
              {graphRoute.node === null ? "Open the graph" : "Open in graph"}
            </a>
            <ReviewQueuePill />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {node === null && <p className="p-4 text-sm text-fg-muted">Choose a file from the tree.</p>}
          {node !== null && paneError !== null && (
            <p role="alert" className="m-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {paneError}
            </p>
          )}
          {node !== null && paneError === null && (shown.kind === "loading" || owner.kind === "pending") && <p className="p-4 text-sm text-fg-muted">Loading…</p>}
          {node !== null && (shown.kind === "missing" || (shown.kind === "ready" && owner.kind === "outside")) && (
            <p className="p-4 text-sm text-fg-muted">That node is not in this view.</p>
          )}
          {shown.kind === "ready" && owner.kind === "found" && <NodePane node={shown.node} tree={owner.tree} onActivate={activate} />}
        </div>
      </section>
    </main>
  );
}

/** A root of the view: its `list` row until the `tree` answer arrives, then the tree's own root row; the truncation notice lives under its children. */
function RootEntry({
  root,
  state,
  expanded,
  selectedId,
  onToggle,
  onActivate,
}: {
  root: RootRow;
  state: TreeState | undefined;
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onActivate: (row: TreeRow) => void;
}) {
  const tree = state?.kind === "ready" ? state.tree : null;
  const row = tree?.rows.get(root.id) ?? rootRowOf(root);
  return (
    <Entry row={row} depth={0} tree={tree} expanded={expanded} selectedId={selectedId} onToggle={onToggle} onActivate={onActivate}>
      {state?.kind === "loading" && <p className="py-1 pl-6 text-xs text-fg-muted">Loading…</p>}
      {state?.kind === "error" && (
        <p role="alert" className="py-1 pl-6 text-xs text-red-300">
          {state.message}
        </p>
      )}
      {state?.kind === "ready" && state.truncated && (
        <p role="note" className="py-1 pl-6 text-xs text-fg-muted">
          Not every entry under {root.title || "(untitled)"} is shown.
        </p>
      )}
    </Entry>
  );
}

/**
 * One entry of the tree pane: a separate expand toggle (containers and roots)
 * beside the activation button, so an activation and an expansion are
 * distinct actions for a screen reader (design.md decision 6). Children
 * render only while expanded, beneath the entry, so expanding moves
 * nothing else in the tree.
 */
function Entry({
  row,
  depth,
  tree,
  expanded,
  selectedId,
  onToggle,
  onActivate,
  children,
}: {
  row: TreeRow;
  depth: number;
  tree: CodeTree | null;
  expanded: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onActivate: (row: TreeRow) => void;
  children?: ReactNode;
}) {
  const expandable = isExpandable(row);
  const isExpanded = expandable && expanded.has(row.id);
  const selected = row.id === selectedId;
  const title = row.title || "(untitled)";
  const entries = isExpanded && tree !== null ? childrenOf(tree, row.id) : [];
  return (
    <li data-node-id={row.id} data-node-type={row.nodeType}>
      <div className="flex items-center gap-0.5" style={{ paddingLeft: `${depth * 0.75}rem` }}>
        {expandable ? (
          <button
            type="button"
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${title}`}
            aria-expanded={isExpanded}
            onClick={() => onToggle(row.id)}
            className="w-5 shrink-0 rounded text-center text-xs text-fg-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span aria-hidden="true" className="w-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onActivate(row)}
          aria-current={selected ? "true" : undefined}
          className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left focus:outline-none focus:ring-2 focus:ring-accent ${selected ? "bg-surface-strong text-fg" : "text-fg-muted hover:bg-surface-strong hover:text-fg"}`}
        >
          {title}
        </button>
      </div>
      {isExpanded && entries.length > 0 && (
        <ul>
          {entries.map((child) => (
            <Entry key={child.id} row={child} depth={depth + 1} tree={tree} expanded={expanded} selectedId={selectedId} onToggle={onToggle} onActivate={onActivate} />
          ))}
        </ul>
      )}
      {isExpanded && children}
    </li>
  );
}

/** The file pane's body by kind (code-view/spec.md, "The file pane shows a node's content by kind"). A `repo` root is a container like a directory (`isContainer`), so it lists its entries rather than printing the loader's child-name list. */
function NodePane({ node, tree, onActivate }: { node: LookedUpNode; tree: CodeTree; onActivate: (row: TreeRow) => void }) {
  if (node.nodeType === "file") {
    return <SourcePane key={node.id} content={node.content} language={metadataText(node.metadata, "language")} />;
  }
  if (isContainer(node.nodeType)) {
    const entries = childrenOf(tree, node.id);
    if (entries.length === 0) {
      return <p className="p-4 text-sm text-fg-muted">This directory has no entries in this view.</p>;
    }
    return (
      <ul aria-label="Directory entries" className="h-full overflow-y-auto p-2 text-sm">
        {entries.map((child) => (
          <li key={child.id} data-node-id={child.id}>
            <button
              type="button"
              onClick={() => onActivate(child)}
              className="w-full truncate rounded px-2 py-1 text-left text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {child.title || "(untitled)"}
              <span className="ml-2 text-xs opacity-70">{child.nodeType}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-xs text-fg">{node.content}</pre>;
}

/** Fills the pane and scrolls inside it, so the page never scrolls. */
const FILL_PANE = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

/**
 * A `file`'s source in a read-only CodeMirror (design.md decision 4):
 * `lineNumbers()`, One Dark, and the grammar `language` names — loaded
 * first, so the editor is built once with it rather than re-tokenized
 * after a flash of plain text; a grammar that fails to load, or none,
 * is plain text. One `EditorState` per node and grammar: the editor is
 * created in an effect that mounts into the host `div` (the way
 * MarkdownEditor.tsx mounts tiptap) and destroyed on the way out. The
 * caller keys this component by node id, so a new node is a fresh mount.
 */
function SourcePane({ content, language }: { content: string; language: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [grammar, setGrammar] = useState<{ language: string | null; support: LanguageSupport | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLanguage(language).then(
      (support) => {
        if (!cancelled) setGrammar({ language, support });
      },
      () => {
        if (!cancelled) setGrammar({ language, support: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    const parent = host.current;
    if (parent === null || grammar === null || grammar.language !== language) {
      return;
    }
    const editor = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [lineNumbers(), oneDark, FILL_PANE, EditorState.readOnly.of(true), EditorView.editable.of(false), ...(grammar.support === null ? [] : [grammar.support])],
      }),
      parent,
    });
    return () => {
      editor.destroy();
    };
  }, [content, language, grammar]);

  return <div ref={host} className="h-full" data-grammar={grammar === null ? undefined : grammar.support === null ? "plain" : (grammar.language ?? "plain")} />;
}
