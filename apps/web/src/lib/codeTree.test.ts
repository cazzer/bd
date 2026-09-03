import { describe, expect, it } from "vitest";
import { ancestorsOf, buildTree, childrenOf, compareTreeRows, isContainer, isExpandable, rootKeyOf, type TreeRow } from "./codeTree.js";

function row(id: string, parentId: string | null, nodeType: string, title: string, extra: Partial<TreeRow> = {}): TreeRow {
  return { id, parentId, nodeType, title, externalId: `k:${id}`, path: null, language: null, ...extra };
}

/** A small checkout, handed over in the server's order (depth, then title in the database's collation). */
const ROOT = row("root", null, "repo", "bd", { externalId: "bd" });
const APPS = row("apps", "root", "directory", "apps");
const README = row("readme", "root", "file", "README.md", { language: "markdown" });
const AGENTS = row("agents", "root", "file", "AGENTS.md", { language: "markdown" });
const DOT = row("dot", "root", "directory", ".agents");
const PKG = row("pkg", "root", "file", "package.json", { language: "json" });
const WEB = row("web", "apps", "directory", "web");
const MCP = row("mcp", "apps", "directory", "mcp");
const SRC = row("src", "web", "directory", "src");
const ROUTE = row("route", "src", "file", "route.ts", { path: "apps/web/src/lib/route.ts", language: "typescript" });
const NAV = row("nav", "src", "file", "navigate.ts", { language: "typescript" });
const SERVER_ORDER = [ROOT, DOT, AGENTS, APPS, PKG, README, MCP, WEB, SRC, NAV, ROUTE];

describe("buildTree", () => {
  it("finds the root, keeps every row, and lists each parent's children containers first then by title", () => {
    const tree = buildTree(SERVER_ORDER);
    expect(tree.rootId).toBe("root");
    expect(tree.rows.size).toBe(SERVER_ORDER.length);
    expect(childrenOf(tree, "root").map((r) => r.title)).toEqual([".agents", "apps", "AGENTS.md", "package.json", "README.md"]);
    expect(childrenOf(tree, "apps").map((r) => r.title)).toEqual(["mcp", "web"]);
    expect(childrenOf(tree, "web").map((r) => r.title)).toEqual(["src"]);
    expect(childrenOf(tree, "src").map((r) => r.title)).toEqual(["navigate.ts", "route.ts"]);
  });

  it("orders the same whatever order the rows arrive in", () => {
    const shuffled = [ROUTE, WEB, PKG, ROOT, NAV, SRC, README, DOT, MCP, APPS, AGENTS];
    const fromShuffled = buildTree(shuffled);
    const fromServer = buildTree(SERVER_ORDER);
    for (const parent of ["root", "apps", "web", "src"]) {
      expect(childrenOf(fromShuffled, parent).map((r) => r.id)).toEqual(childrenOf(fromServer, parent).map((r) => r.id));
    }
  });

  it("a leaf has no children entry and an unknown id answers an empty list", () => {
    const tree = buildTree(SERVER_ORDER);
    expect(tree.children.has("route")).toBe(false);
    expect(childrenOf(tree, "route")).toEqual([]);
    expect(childrenOf(tree, "nowhere")).toEqual([]);
  });

  it("a truncated answer keeps what it has: a row whose parent is missing stays in rows but is attached nowhere", () => {
    // The server cut the answer after `web` but a hand-written child of a
    // dropped directory slipped in; it must not attach to the root or throw.
    const orphan = row("orphan", "dropped", "file", "orphan.ts");
    const tree = buildTree([ROOT, DOT, AGENTS, APPS, WEB, orphan]);
    expect(tree.rows.has("orphan")).toBe(true);
    expect([...tree.children.values()].flat().map((r) => r.id)).not.toContain("orphan");
    expect(childrenOf(tree, "root").map((r) => r.id)).toEqual(["dot", "apps", "agents"]);
    expect(ancestorsOf(tree, "orphan")).toBeNull();
  });

  it("no parentless row means no root; a repeated id keeps the first row", () => {
    expect(buildTree([APPS, WEB]).rootId).toBeNull();
    const tree = buildTree([ROOT, APPS, { ...APPS, title: "later" }]);
    expect(tree.rows.get("apps")?.title).toBe("apps");
    expect(childrenOf(tree, "root")).toHaveLength(1);
  });

  it("digits compare numerically and ties fall back to id", () => {
    const a = row("b", "root", "file", "chunk10.ts");
    const b = row("a", "root", "file", "chunk2.ts");
    const c = row("c", "root", "file", "chunk2.ts");
    expect(childrenOf(buildTree([ROOT, a, b, c]), "root").map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(compareTreeRows(a, b)).toBeGreaterThan(0);
  });
});

describe("ancestorsOf", () => {
  const tree = buildTree(SERVER_ORDER);

  it("answers the id chain from the root down to the node's parent", () => {
    expect(ancestorsOf(tree, "route")).toEqual(["root", "apps", "web", "src"]);
    expect(ancestorsOf(tree, "web")).toEqual(["root", "apps"]);
    expect(ancestorsOf(tree, "apps")).toEqual(["root"]);
  });

  it("the root answers an empty chain; a node not in the tree answers null", () => {
    expect(ancestorsOf(tree, "root")).toEqual([]);
    expect(ancestorsOf(tree, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("a parent loop among the rows terminates with null instead of walking forever", () => {
    const looped = buildTree([ROOT, row("a", "b", "directory", "a"), row("b", "a", "directory", "b")]);
    expect(ancestorsOf(looped, "a")).toBeNull();
    expect(ancestorsOf(looped, "b")).toBeNull();
  });
});

describe("rootKeyOf, isContainer, and isExpandable", () => {
  it("takes the text before the first colon, or the whole id", () => {
    expect(rootKeyOf("bd:apps/web/src/lib/route.ts")).toBe("bd");
    expect(rootKeyOf("bd:docs/a:b.md")).toBe("bd");
    expect(rootKeyOf("bd")).toBe("bd");
    expect(rootKeyOf("")).toBe("");
    expect(rootKeyOf(":x")).toBe("");
  });

  it("directories and repos are containers; files and anything else are not", () => {
    expect(isContainer("directory")).toBe(true);
    expect(isContainer("repo")).toBe(true);
    expect(isContainer("file")).toBe(false);
    expect(isContainer("work_item")).toBe(false);
  });

  it("a root of any type is expandable; below the root only containers are", () => {
    expect(isExpandable(row("epic", null, "work_item", "bd-hmd"))).toBe(true);
    expect(isExpandable(ROOT)).toBe(true);
    expect(isExpandable(APPS)).toBe(true);
    expect(isExpandable(README)).toBe(false);
    expect(isExpandable(row("item", "epic", "work_item", "bd-hmd.3"))).toBe(false);
  });
});
