## Why

The repository loader (`git-repo-ingestor`) now puts a checkout into the store as `repo`, `directory`, and `file` nodes joined by `child_of`, and `node-views` reserved a `code` renderer that nothing draws. Today a source file found by search is shown as a graph node with a markdown excerpt of its content — the wrong shape for code. A person who asks "show me this repository" wants what every code host gives them: a tree on the left, the file on the right, highlighted. This is the third and last view of the views program, and the one the loader was built for.

## What Changes

- **A code view at `/code`.** Addressed by a `view` node's id and, optionally, a node inside it: `/code?view=<id>&node=<id>`. The view's filter lists the roots (a repository root, or several); the left pane is a file tree under those roots, expanded per directory; the right pane is the selected file's source, read-only, with syntax highlighting chosen from the file's `language` metadata. Selecting a directory shows its listing. A deep link opens the named file with its ancestors expanded.
- **A bounded subtree read.** One new core read walks `child_of` downward from a root — merge-folded, cycle-safe, capped by depth and by node count — and returns the tree's structure without content. The web API exposes it as one procedure, so drawing a tree is one request and a deep link is two.
- **The detail panel's affordance generalizes.** "Open as feed · <title>" becomes renderer-keyed: a node whose resolved default view is a code view offers "Open as code · <title>", and the address it opens carries the selected node, so a file found in the graph is one click from being read. The graph still never navigates on its own.
- **Two new front-end dependencies**: CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, the One Dark theme) and its language packages, loaded per language on demand so a view with no TypeScript file never downloads the TypeScript grammar.
- **No schema change, no migration, no new node or edge type.** The code view reads `file`, `directory`, and `repo` nodes as the loader wrote them and `view` nodes as `node-views` defined them.

## Non-Goals

- **No editing.** The pane is read-only. The store's write path for importer-owned nodes refuses `git` nodes anyway, and a change made in the browser would be overwritten by the next load. Editing code belongs in an editor with a checkout.
- **No search inside the code view.** Full-text search over file content already works from the graph (`route.ts` finds `graphRouteFromSearch` today); a search box in the code view is a later change.
- **No view editor.** As with the feed, a code view is written over MCP: a `view` with `renderer: "code"` and a filter that lists roots, plus a `default_view` edge from the root so every file under it inherits.
- **No rendering of removed files.** A file deleted from the checkout stays in the store until the stale sweep (`bd-aow.3`) lands; the tree shows what the store holds.
- **No automatic navigation from the graph.** `node-views` established that a node's preferred view is offered, never forced; a click on a `file` node in the graph still selects it there.

## Capabilities

### New Capabilities

- `code-view`: what the code view shows and how it is addressed — roots from the view's filter, a tree from `child_of`, a highlighted read-only file pane, directory listings, deep links, the empty states, and the bounded subtree read the tree is built from.

### Modified Capabilities

- `node-views`: the detail panel's affordance is defined for the `code` renderer, and the address it opens carries the selected node.
- `local-web-api`: the read surface gains a bounded subtree read.

## Impact

- `packages/core`: new `tree.ts` — `getSubtree(db, rootId, options)` and its query builder; exports. Tests for the bound, the cycle guard, merge folding, and ordering.
- `apps/web`: `src/lib/route.ts` gains `CodeRoute`; `src/App.tsx` gains a case; new `src/components/CodeView.tsx` with pure helpers in `src/lib/codeTree.ts` (tree assembly, ancestor expansion, ordering) and `src/lib/codeLanguage.ts` (language → grammar loader); `src/components/DetailPanel.tsx` and `GraphView.tsx` generalize the affordance; `server/routers/read.ts` gains `tree`. `package.json` gains the CodeMirror packages.
- `packages/db`, `apps/mcp`: untouched.
- Rejected alternatives: building the tree from `getNeighbors` one directory at a time with no new procedure (a deep link then walks the path from the root with one sequential request per level, and every neighbour carries a store-wide degree the tree never shows); a `children(parentIds)` procedure (still needs a second procedure or a walk to expand a deep link's ancestors); Monaco for the pane (several megabytes and a worker for a read-only view); a highlight-only library (no line numbers, selection, or scroll model without writing them).
