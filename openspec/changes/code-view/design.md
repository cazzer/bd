## Context

See proposal.md for motivation. What shapes the approach, as it stands on the `views-int` integration branch:

- **The shell is a switch on `route.view`** (`apps/web/src/App.tsx`), `Route = GraphRoute | FeedRoute` in `src/lib/route.ts` with a `formatRoute` case per member, and `lib/navigate.ts` is the one history writer. `FeedView` is the pattern for a view driven by a `view` node: `getNodes` for the view, guard `nodeType === "view"` and an object `filter`, then `list` with the filter spread in; three empty states that never redirect.
- **`GraphView` resolves the selected node's default view after selection** and hands `DetailPanel` a `defaultView`; the panel offers "Open as feed · <title>" only for renderer `feed`, and `GraphView.handleOpenDefaultView` performs the push after `leaveView()` disarms in-flight work. `VIEW_RENDERERS` already includes `code`.
- **The loader's tree**: `repo` root (external id `<key>`, metadata `{ key, root_path }`), `directory` (`<key>:<path>`, metadata `{ path }`, content = sorted child names), `file` (`<key>:<path>`, metadata `{ path, size_bytes, line_count, blob_sha, language? }`, content = source). Exactly one `child_of` per non-root node, weight 1, source `git`. Titles are base names. `language` is a fixed map (`typescript`, `javascript`, `markdown`, `json`, `yaml`, `sql`, `css`, `html`, `shell`, `python`, `go`, `rust`, `toml`) and absent otherwise. A path tree cannot cycle, but `brain_link` can write `child_of` freely, so a walk still guards.
- **No lookup by external id on the web** (`bd-wq4` is open), so a file's ancestors cannot be fetched by their external ids; and `getNeighbors` computes a store-wide degree per neighbour and returns no metadata.
- **`resolveDefaultViews`' ancestor CTE** (`packages/core/src/views.ts`) is the house shape for a `child_of` walk: alias CTE for merged inputs, both endpoints folded through `coalesce(merged_into, id)`, `UNION`, a depth cap as the terminator, `edges_src_id_edge_type_idx`. The downward walk needs `edges_dst_id_edge_type_idx`, which exists.
- **The app's chrome is dark** (`glass`, `ambience`, `text-fg`, `bg-surface-strong` in `index.css`), and the only rich renderer is tiptap for markdown.

## Goals / Non-Goals

**Goals:**

- One request draws a tree; a deep link is two. No per-directory round trip in the common case.
- Every new read folds merges and terminates on a cycle, as the two existing `child_of` walks do.
- The code view reuses the feed's view-loading contract unchanged, so a view is a view whichever pane draws it.
- The graph's "offered, never forced" stance is preserved; the offer just gets better at naming where it goes.

**Non-Goals:**

- A tree that paginates or streams. A bound with a "cut short" flag is the whole story for v1.
- Highlighting inside the graph's detail panel. A `file` node selected in the graph still shows its excerpt there; the code view is where code is read.
- Persisting expansion state or scroll position. Expansion is derived from the address (the selected node's ancestors) plus what the person toggles in the session.
- A grammar for every language the loader names. Unmapped languages fall back to plain text, and the map grows when someone loads a repository that needs it.

## Decisions

### 1. One bounded subtree read (`getSubtree`) instead of per-directory neighbour fetches

`packages/core/src/tree.ts` exports `MAX_SUBTREE_NODES` (5000), `MAX_SUBTREE_DEPTH` (32), `buildGetSubtreeQuery`, and `getSubtree(db, rootId)`. Shape: `alias` CTE folds the root id; `descendants(node_id, parent_id, depth)` starts at `(root, null, 0)` and joins `edges e` on `e.edge_type = 'child_of'` with `coalesce(dst.merged_into, e.dst_id) = descendants.node_id`, yielding `coalesce(src.merged_into, e.src_id)` at `depth + 1`, `UNION` with `depth < MAX_SUBTREE_DEPTH`. The outer query joins `resolved_nodes`, takes `DISTINCT ON (node_id)` at the least depth, orders by `depth, title, node_id`, and fetches `MAX_SUBTREE_NODES + 1` rows so `truncated` is known without a count. Each row carries `id, parentId, nodeType, title, externalId, path, language` (the two metadata keys projected as `metadata->>'path'` and `metadata->>'language'`); never content. The root row's `parentId` is null. A malformed root is rejected before any SQL (`BAD_REQUEST` at the router); an unknown root is core's not-found, which the router maps to `NOT_FOUND` through `mapCoreError` like `getNeighbors` and `getNodeHistory` — nothing is walked either way.

*Why the walk is safe here when fan-out recursions elsewhere are bounded per hop.* A file tree's fan-out is real (79 directories, 237 files here), but the walk is bounded by node count, not by depth alone: `LIMIT MAX_SUBTREE_NODES + 1` over a `depth`-ordered result lets Postgres stop the recursive scan early only in the best case, so the CTE is also depth-capped and the table it walks is the tree itself, not the store. 5000 nodes at ~150 bytes is well under the 2 MB response budget the other procedures apply, so the procedure bounds by count and skips `boundResponse`. A repository over the bound shows a truncated tree rather than nothing; raising the bound is a constant.

*Rejected: `getNeighbors` per directory.* Zero server change, but a deep link to `apps/web/src/lib/route.ts` walks four levels sequentially from the root (no external-id lookup exists), each neighbour carries a store-wide degree the tree never shows, and the tree must filter `child_of`/incoming client-side. *Rejected: `children(parentIds)`.* Batched and cheap, but a deep link still needs an ancestor read or the same walk; two procedures to do what one does. *Rejected: a `getAncestors` beside `children`.* The right pair for a store whose trees are too big to read whole; not this one's.

### 2. Route grammar: `/code?view=<id>&node=<id>`

`CodeRoute = { view: "code"; viewId: string | null; node: string | null }`, `CODE_VIEW_PATH = "/code"`, `parseRoute` accepts `/code` and `/code/`, `formatRoute` emits `view` then `node`, absent ones omitted. Malformed values degrade to `null` exactly as the feed's `view` and the graph's `node` do; validity is the server's.

*Selection is a push, not a replace.* The graph replaces on selection because a selection is a state of one drawing; a file is a document, and back-to-the-previous-file is what every code host does. The feed's row activation is a push for the same reason. *Rejected: replace.* Ten files read, one back press to the graph — surprising in a code browser, and it makes the address useless as a reading trail.

### 3. The code view loads the view like the feed, then one tree per root

`CodeView` mirrors `FeedView`'s first two reads verbatim: `getNodes` for the view node, `viewFilterOf` (the same guard, lifted into `src/lib/viewFilter.ts` so both share it), then `list` with `{ ...filter, limit: 50 }` for the roots. The renderer is not checked: `/code` draws any view's selection as a tree, and a root without `child_of` children is a leaf. One root → expanded to its first level and its `tree` read issued at once; several → each collapsed, its `tree` read issued on first expansion. The tree read for a root is cached in state keyed by root id for the life of the view.

*Deep link.* With `node` set, the view reads `getNodes([node])` in parallel with the roots; the node's `externalId` up to the first `:` is the loader's key, which equals the root's `externalId` — so the owning root is known without a walk, its tree is read, and the ancestor chain is computed client-side by following `parentId` (`src/lib/codeTree.ts`, pure). If no root's tree contains the node (a node from another source, or a truncated tree), the "not in this view" state shows and the address stays.

*Rejected: checking `renderer === "code"`.* A feed view opened at `/code` is a harmless tree of leaves, and refusing it would make the renderer a permission rather than a default. *Rejected: reading `metadata.path` and matching external ids.* Same information, one more assumption about the loader's id scheme; `parentId` is what the read returns.

### 4. CodeMirror 6, read-only, One Dark, grammars loaded per language

Dependencies: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/theme-one-dark`, and per-language packages (`@codemirror/lang-javascript` for `typescript`/`javascript` with the `typescript`/`jsx` flags, `@codemirror/lang-markdown`, `-json`, `-yaml`, `-sql`, `-css`, `-html`, `-python`, `-go`, `-rust`; `shell` and `toml` via `@codemirror/legacy-modes` stream parsers). `src/lib/codeLanguage.ts` maps `language` → a lazy `() => import(...)` returning a `LanguageSupport | null`; unmapped → null → plain text. The pane builds one `EditorState` with `EditorState.readOnly.of(true)`, `EditorView.editable.of(false)`, `lineNumbers()`, `oneDark`, and the loaded language; it is recreated when the node or the grammar changes. No React wrapper package — the view is one `useEffect` that mounts into a `div`, the way `MarkdownEditor.tsx` mounts tiptap.

*Rejected: Monaco.* Several megabytes plus a worker for a pane that never edits. *Rejected: Shiki / highlight.js.* Tokens only; line numbers, selection, and a scroll model would be hand-written, and the moment the pane gains search or folding they are rewritten. *Rejected: tiptap's code block.* A rich-text editor's code block has no grammar per language and is the wrong tool. *Rejected: a custom theme from the app's CSS variables.* Worth doing once the pane is looked at daily; One Dark matches the chrome well enough to ship and is one import.

### 5. The affordance is keyed by renderer; the code offer carries the selected node

`DetailPanel` derives `offer = defaultView?.view` when its renderer is `feed` or `code` and labels the button "Open as feed · <title>" / "Open as code · <title>"; `onOpenDefaultView(view)` now passes `{ id, renderer }`. `GraphView.handleOpenDefaultView` calls `leaveView()` then pushes `{ view: "feed", viewId }` or `{ view: "code", viewId, node: selectedNodeId }`. Nothing else in the graph changes: activation of a `file` node selects it, as for any node.

*Rejected: auto-opening a `file` node's code view on activation.* `node-views/spec.md` says offered, never forced, and a search hit's neighbourhood is exactly what a person activating a file in the graph came for.

### 6. Layout: two panes inside the app's chrome

A `main` at `h-dvh` with a fixed-width tree pane (`w-72`, its own scroll) and a flexible file pane (its own scroll, CodeMirror sized to fill). Header carries the view's title, the selected node's path, and the "Open in graph" link; the tree and file panes are `nav` and `section` with labels. Keyboard: tree entries are buttons in a list, expansion is a separate toggle button so an activation and an expansion are distinct actions for a screen reader. Empty states keep the header and the link to the graph, as the feed does.

## Risks / Trade-offs

- **A repository over 5000 nodes is truncated.** → The pane says so per root; the bound is one constant; the walk is already depth-capped and ordered shallowest-first so the visible structure is the useful part. Pagination is the follow-up if a real repository hits it.
- **`child_of` written by hand can point a file at two parents or form a cycle.** → `DISTINCT ON` at least depth places each node once; the depth cap terminates; a test writes a two-node cycle under a root.
- **Per-language dynamic imports add a request per first-seen language.** → Cached by the module system after the first; the alternative is shipping every grammar to every view.
- **The view's `list` page is 50 roots.** → A view whose filter selects more than 50 nodes is not a code view in any useful sense; the "load more" affordance is not drawn, and the header says how many roots are shown.
- **`getNodes` for the deep-linked node runs before its root's tree is known.** → It is needed anyway for the file's content, and its external id is what names the root; the two reads are parallel, not sequential.
- **Push-per-file history grows.** → It is the reading trail; the graph's replace rule was about selection within a drawing and is untouched.

## Migration Plan

No schema change. `pnpm install` for the new packages; deploy is a normal build. Rollback: revert the code; nothing in the store is specific to this view.
