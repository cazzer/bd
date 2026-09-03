// The code view's tree, assembled from the `tree` procedure's rows
// (code-view, design.md decisions 1 and 3). Pure: the rows are the wire
// shape (`id`, `parentId`, `nodeType`, `title`, `externalId`, `path`,
// `language` — never content), the output is two maps, and nothing here
// touches React or the client, so the node-environment test next door
// covers ordering, ancestry, and a cut-short answer without a browser.
//
// Ordering is the client's (design.md, Impact: "tree assembly, ancestor
// expansion, ordering"): the server orders `depth, title, node_id` in the
// database's collation, which puts every child of one parent in title
// order but not containers first; each sibling list here is containers
// (`directory`, `repo`) first, then the rest, each group by title in
// English collation with digits compared numerically (`file2` before
// `file10`), ties by id so the order is total. A dotfile therefore sorts
// before a letter (`.agents` before `AGENTS.md`), the way a code host
// lists a checkout.
//
// A truncated tree keeps what it has: a row whose parent is not among the
// rows is kept in `rows` but attached nowhere, so `ancestorsOf` answers
// `null` for it — "not in this view" rather than a broken chain. The
// server's depth-first order means that cannot happen to a `tree` answer
// (a kept node's parent is always kept, tree.ts's header), but the
// function does not rely on it.

/** One row of a `tree` answer — the shape `apps/web/server/routers/read.ts`'s `tree` returns, restated here so this module imports nothing. */
export interface TreeRow {
  id: string;
  /** `null` for the root row only. */
  parentId: string | null;
  nodeType: string;
  title: string;
  externalId: string;
  path: string | null;
  language: string | null;
}

export interface CodeTree {
  /** The first parentless row's id, or `null` when the rows hold none (a `tree` answer always holds exactly one). */
  rootId: string | null;
  /** Every row by id, attached or not. */
  rows: ReadonlyMap<string, TreeRow>;
  /** Each parent's children in display order; a parent with none has no entry. Only rows whose parent is among the rows appear. */
  children: ReadonlyMap<string, readonly TreeRow[]>;
}

/** The node types the tree pane expands: the loader's `directory`, and `repo` — a root that is itself the top directory of a checkout. */
export function isContainer(nodeType: string): boolean {
  return nodeType === "directory" || nodeType === "repo";
}

/**
 * The rows the tree pane gives an expand toggle: a container, or any root
 * (`parentId === null` — the `list` row a root is drawn from before its
 * `tree` answer and the answer's own root row both have none). A view's
 * root can be anything with `child_of` children — an epic over its work
 * items — so its type does not decide; the `tree` answer does, and a root
 * with no children opens to nothing.
 */
export function isExpandable(row: Pick<TreeRow, "nodeType" | "parentId">): boolean {
  return isContainer(row.nodeType) || row.parentId === null;
}

const TITLE_COLLATOR = new Intl.Collator("en", { numeric: true });

/** Containers first, then by title, then by id. Exported so the file pane can order a directory's listing the same way. */
export function compareTreeRows(a: TreeRow, b: TreeRow): number {
  const containerRank = (isContainer(a.nodeType) ? 0 : 1) - (isContainer(b.nodeType) ? 0 : 1);
  if (containerRank !== 0) {
    return containerRank;
  }
  return TITLE_COLLATOR.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Assemble the rows into a tree: the root, every row by id, and each parent's children in display order. */
export function buildTree(rows: readonly TreeRow[]): CodeTree {
  const byId = new Map<string, TreeRow>();
  let rootId: string | null = null;
  for (const row of rows) {
    if (byId.has(row.id)) {
      continue;
    }
    byId.set(row.id, row);
    if (row.parentId === null && rootId === null) {
      rootId = row.id;
    }
  }
  const children = new Map<string, TreeRow[]>();
  for (const row of byId.values()) {
    if (row.parentId === null || !byId.has(row.parentId)) {
      continue;
    }
    let siblings = children.get(row.parentId);
    if (siblings === undefined) {
      siblings = [];
      children.set(row.parentId, siblings);
    }
    siblings.push(row);
  }
  for (const siblings of children.values()) {
    siblings.sort(compareTreeRows);
  }
  return { rootId, rows: byId, children };
}

/** The children of `parentId` in display order; empty when it has none or is not in the tree. */
export function childrenOf(tree: CodeTree, parentId: string): readonly TreeRow[] {
  return tree.children.get(parentId) ?? [];
}

/**
 * The ids from the root down to `nodeId`'s parent — what the tree pane
 * expands to bring the node into view — or `null` when the node is not
 * in the tree, or its chain does not reach a root (a row cut loose by
 * truncation, or a hand-written `child_of` loop among the rows). The root
 * itself answers `[]`.
 */
export function ancestorsOf(tree: CodeTree, nodeId: string): string[] | null {
  const row = tree.rows.get(nodeId);
  if (row === undefined) {
    return null;
  }
  const chain: string[] = [];
  const seen = new Set<string>([nodeId]);
  let parentId = row.parentId;
  while (parentId !== null) {
    const parent = tree.rows.get(parentId);
    if (parent === undefined || seen.has(parentId)) {
      return null;
    }
    seen.add(parentId);
    chain.push(parentId);
    parentId = parent.parentId;
  }
  return chain.reverse();
}

/**
 * The loader's key from an external id: the text before the first `:`
 * (`bd:apps/web/src/lib/route.ts` → `bd`), or the whole id when there is
 * none — a `repo` root's external id is the key itself, so a file and its
 * root answer the same key and the owning root of a deep link is known
 * without a walk (design.md decision 3).
 */
export function rootKeyOf(externalId: string): string {
  const colon = externalId.indexOf(":");
  return colon === -1 ? externalId : externalId.slice(0, colon);
}
