import { eq, inArray } from "drizzle-orm";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { InvalidListOptionError, InvalidLookupIdError, InvalidViewError } from "./errors.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { listNodes, MAX_LIST_LIMIT } from "./list.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";
import {
  buildResolveDefaultViewsQuery,
  DEFAULT_VIEW_EDGE_TYPE,
  MAX_RESOLVE_DEPTH,
  MAX_RESOLVE_IDS,
  normalizeViewMetadata,
  resolveDefaultViews,
  VIEW_NODE_TYPE,
} from "./views.js";

// Every fixture in this file carries this source system, and every test
// prefixes its external ids with a fresh `fx()` — so nothing here is ever
// asserted store-wide, and other suites sharing the database are invisible.
const SRC = `views-test-${uniqueSuffix()}`;
const FEED_FILTER = { nodeTypes: ["work_item"], where: [{ key: "status", op: "equals", value: "open" }] };
const NO_NODE_ID = "00000000-0000-4000-8000-000000000000";

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
const openRuns: string[] = [];

/** A unique prefix per test so fixtures never collide across tests in this file. */
const fx = () => `fx-${uniqueSuffix()}`;

async function writeNode(externalId: string, nodeType: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const result = await upsertNodes(db, run, [{ nodeType, sourceSystem: SRC, externalId, title: `${nodeType} ${externalId}`, content: "", metadata }]);
  const row = result.rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row.id;
}

/** A view node, written through the contract the way every writer must. */
function writeView(externalId: string, renderer = "feed"): Promise<string> {
  return writeNode(externalId, VIEW_NODE_TYPE, normalizeViewMetadata({ renderer, filter: FEED_FILTER }));
}

function writeItem(externalId: string): Promise<string> {
  return writeNode(externalId, "work_item", { status: "open", priority: 2 });
}

async function link(srcId: string, dstId: string, edgeType: string, weight?: number): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType, sourceSystem: SRC, weight }]);
}

const childOf = (child: string, parent: string) => link(child, parent, CHILD_OF_EDGE_TYPE);
const declares = (node: string, view: string, weight?: number) => link(node, view, DEFAULT_VIEW_EDGE_TYPE, weight);

const answer = (nodeId: string, viewId: string, title: string, declaredBy: string) => ({
  nodeId,
  view: { id: viewId, title, renderer: "feed" },
  declaredBy,
});
const none = (nodeId: string) => ({ nodeId, view: null, declaredBy: null });

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC, { actor: "views-suite" });
  openRuns.push(run.id);
});

afterAll(async () => {
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRuns));
  await pool.end();
});

describe("normalizeViewMetadata", () => {
  function rejection(metadata: Record<string, unknown> | undefined, itemLabel?: string): InvalidViewError {
    let thrown: unknown;
    try {
      normalizeViewMetadata(metadata, itemLabel === undefined ? {} : { itemLabel });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidViewError);
    return thrown as InvalidViewError;
  }

  it("accepts every renderer, copies the filter, and passes unknown keys through", () => {
    const out = normalizeViewMetadata({ renderer: "feed", filter: FEED_FILTER, note: "kept" });
    expect(out).toEqual({ renderer: "feed", filter: FEED_FILTER, note: "kept" });
    expect(out["filter"]).not.toBe(FEED_FILTER);
    for (const renderer of ["graph", "feed", "code", "timeline", "board"]) {
      expect(normalizeViewMetadata({ renderer, filter: {} })["renderer"]).toBe(renderer);
    }
    expect(normalizeViewMetadata({ renderer: "timeline", filter: { nodeTypes: ["gh-issue", "work_item"] } })).toEqual({ renderer: "timeline", filter: { nodeTypes: ["gh-issue", "work_item"] } });
  });

  it("rejects an unknown renderer naming the item and the field", () => {
    const e = rejection({ renderer: "kanban", filter: {} }, "at batch index 3 (agent/v)");
    expect(e.field).toBe("renderer");
    expect(e.value).toBe("kanban");
    expect(e.item).toBe("at batch index 3 (agent/v)");
    expect(e.message).toBe('invalid view at batch index 3 (agent/v): renderer (got "kanban") must be one of graph, feed, code, timeline, board');
    expect(rejection({ filter: {} }).field).toBe("renderer");
    expect(rejection(undefined).field).toBe("renderer");
    expect(rejection(undefined).message).toMatch(/^invalid view: renderer/);
  });

  it("rejects a missing, null, or non-object filter naming filter", () => {
    expect(rejection({ renderer: "feed" }).field).toBe("filter");
    expect(rejection({ renderer: "feed", filter: null }).field).toBe("filter");
    expect(rejection({ renderer: "feed", filter: "status=open" }).field).toBe("filter");
    expect(rejection({ renderer: "feed", filter: [] }).field).toBe("filter");
  });

  it("rejects a malformed predicate naming filter and the offending predicate, keeping the listing error as cause", () => {
    const e = rejection({ renderer: "feed", filter: { where: [{ key: "status", op: "contains", value: "op" }] } });
    expect(e.field).toBe("filter.where[0].op");
    expect(e.value).toBe("contains");
    expect(e.cause).toBeInstanceOf(InvalidListOptionError);
    expect(e.message).toContain('filter.where[0].op (got "contains") must be "equals" or "oneOf"');
    expect(rejection({ renderer: "feed", filter: { where: [{ key: "status", op: "equals", value: { nested: true } }] } }).field).toBe("filter.where[0].value");
    expect(rejection({ renderer: "feed", filter: { nodeTypes: [] } }).field).toBe("filter.nodeTypes");
  });

  it("refuses the reader's limit and cursor inside a filter", () => {
    const limit = rejection({ renderer: "feed", filter: { limit: 10 } });
    expect(limit.field).toBe("filter.limit");
    expect(limit.value).toBe(10);
    expect(rejection({ renderer: "feed", filter: { cursor: null } }).field).toBe("filter.cursor");
  });

  it("refuses a key that is not a listing option, which listNodes would silently ignore", () => {
    const e = rejection({ renderer: "feed", filter: { node_types: ["work_item"] } });
    expect(e.field).toBe("filter.node_types");
    expect(e.value).toEqual(["work_item"]);
    expect(e.message).toBe('invalid view: filter.node_types (got ["work_item"]) is not a listing option');
  });
});

describe("view nodes in the store", () => {
  it("persists a valid view and lists it by type with its renderer and filter", async () => {
    const p = fx();
    const id = await writeView(`${p}-open`);
    const listed = await listNodes(db, { nodeTypes: [VIEW_NODE_TYPE], sourceSystems: [SRC], limit: MAX_LIST_LIMIT });
    const mine = listed.nodes.find((n) => n.id === id);
    expect(mine?.metadata).toEqual({ renderer: "feed", filter: FEED_FILTER });
  });

  it("persists a timeline view through the contract and lists it with its renderer", async () => {
    const p = fx();
    const id = await writeView(`${p}-history`, "timeline");
    const listed = await listNodes(db, { nodeTypes: [VIEW_NODE_TYPE], sourceSystems: [SRC], limit: MAX_LIST_LIMIT });
    expect(listed.nodes.find((n) => n.id === id)?.metadata).toEqual({ renderer: "timeline", filter: FEED_FILTER });
  });

  it("applies no view validation to a node of another type carrying a renderer key", async () => {
    const p = fx();
    const id = await writeNode(`${p}-note`, "note", { renderer: "kanban" });
    const [row] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, id));
    expect(row?.metadata).toEqual({ renderer: "kanban" });
  });
});

describe("resolveDefaultViews", () => {
  it("a node's own declaration beats its parent's", async () => {
    const p = fx();
    const viewA = await writeView(`${p}-a`);
    const viewB = await writeView(`${p}-b`);
    const parent = await writeItem(`${p}-parent`);
    const child = await writeItem(`${p}-child`);
    await childOf(child, parent);
    await declares(child, viewA);
    await declares(parent, viewB);

    expect(await resolveDefaultViews(db, [child, parent])).toEqual([
      answer(child, viewA, `view ${p}-a`, child),
      answer(parent, viewB, `view ${p}-b`, parent),
    ]);
  });

  it("inherits from the nearest ancestor that declares", async () => {
    const p = fx();
    const view = await writeView(`${p}-v`);
    const grandparent = await writeItem(`${p}-gp`);
    const parent = await writeItem(`${p}-p`);
    const grandchild = await writeItem(`${p}-gc`);
    await childOf(grandchild, parent);
    await childOf(parent, grandparent);
    await declares(grandparent, view);

    expect(await resolveDefaultViews(db, [grandchild, parent, grandparent])).toEqual([
      answer(grandchild, view, `view ${p}-v`, grandparent),
      answer(parent, view, `view ${p}-v`, grandparent),
      answer(grandparent, view, `view ${p}-v`, grandparent),
    ]);
  });

  it("answers null, not an error, when nothing is declared and for an id naming no node", async () => {
    const p = fx();
    const parent = await writeItem(`${p}-parent`);
    const child = await writeItem(`${p}-child`);
    await childOf(child, parent);

    expect(await resolveDefaultViews(db, [child, NO_NODE_ID])).toEqual([none(child), none(NO_NODE_ID)]);
  });

  it("answers a mixed batch independently, in input order, in one statement", async () => {
    const p = fx();
    const viewV = await writeView(`${p}-v`);
    const viewW = await writeView(`${p}-w`);
    const epic = await writeItem(`${p}-epic`);
    await declares(epic, viewV);
    const children: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const child = await writeItem(`${p}-child-${i}`);
      await childOf(child, epic);
      children.push(child);
    }
    const loner = await writeItem(`${p}-loner`);
    const other = await writeItem(`${p}-other`);
    await declares(other, viewW);

    let executed = 0;
    const counting = {
      execute: (query: SQL) => {
        executed += 1;
        return db.execute(query);
      },
    } as unknown as Database;

    const ids = [children[2]!, loner, other, NO_NODE_ID, epic, children[0]!, children[2]!];
    const result = await resolveDefaultViews(counting, ids);
    expect(executed).toBe(1);
    expect(result).toEqual([
      answer(children[2]!, viewV, `view ${p}-v`, epic),
      none(loner),
      answer(other, viewW, `view ${p}-w`, other),
      none(NO_NODE_ID),
      answer(epic, viewV, `view ${p}-v`, epic),
      answer(children[0]!, viewV, `view ${p}-v`, epic),
      answer(children[2]!, viewV, `view ${p}-v`, epic),
    ]);
  });

  it("folds merges: a merged-away ancestor, a merged-away input, and a declaration on a merged-away duplicate", async () => {
    const p = fx();
    const viewV = await writeView(`${p}-v`);
    // child -> child_of -> loserParent; loserParent merged into survivorParent, which declares V.
    const loserParent = await writeItem(`${p}-loser-parent`);
    const survivorParent = await writeItem(`${p}-survivor-parent`);
    const child = await writeItem(`${p}-child`);
    await childOf(child, loserParent);
    await declares(survivorParent, viewV);
    await mergeNodes(db, loserParent, survivorParent, run);
    // A merged-away input: loserChild merged into child.
    const loserChild = await writeItem(`${p}-loser-child`);
    await mergeNodes(db, loserChild, child, run);
    // A declaration on a merged-away duplicate, honoured through its survivor.
    const viewW = await writeView(`${p}-w`);
    const loserDecl = await writeItem(`${p}-loser-decl`);
    const survivorDecl = await writeItem(`${p}-survivor-decl`);
    await declares(loserDecl, viewW);
    await mergeNodes(db, loserDecl, survivorDecl, run);

    expect(await resolveDefaultViews(db, [child, loserChild, survivorDecl, loserParent])).toEqual([
      answer(child, viewV, `view ${p}-v`, survivorParent),
      answer(loserChild, viewV, `view ${p}-v`, survivorParent),
      answer(survivorDecl, viewW, `view ${p}-w`, survivorDecl),
      answer(loserParent, viewV, `view ${p}-v`, survivorParent),
    ]);
  });

  it("follows a default_view edge to a merged-away view through to the surviving view", async () => {
    const p = fx();
    const loserView = await writeView(`${p}-loser-view`);
    const survivorView = await writeView(`${p}-survivor-view`);
    const item = await writeItem(`${p}-item`);
    await declares(item, loserView);
    await mergeNodes(db, loserView, survivorView, run);

    expect(await resolveDefaultViews(db, [item])).toEqual([answer(item, survivorView, `view ${p}-survivor-view`, item)]);
  });

  it("ignores a default_view edge whose target is not a view", async () => {
    const p = fx();
    const note = await writeNode(`${p}-note`, "note");
    const item = await writeItem(`${p}-item`);
    await declares(item, note);

    expect(await resolveDefaultViews(db, [item])).toEqual([none(item)]);
  });

  it("survives a re-import of the governed node", async () => {
    const p = fx();
    const view = await writeView(`${p}-v`);
    const item = await writeItem(`${p}-item`);
    await declares(item, view);

    const reimport = await openIngestRun(db, SRC, { actor: "reimport" });
    openRuns.push(reimport.id);
    const rewritten = await upsertNodes(db, reimport, [
      { nodeType: "work_item", sourceSystem: SRC, externalId: `${p}-item`, title: "renamed by the importer", content: "new body", metadata: { status: "closed", priority: 0 } },
    ]);
    expect(rewritten.rows[0]?.action).toBe("updated");

    expect(await resolveDefaultViews(db, [item])).toEqual([answer(item, view, `view ${p}-v`, item)]);
  });

  it("picks the heavier of two default_view edges on one node", async () => {
    const p = fx();
    const light = await writeView(`${p}-light`);
    const heavy = await writeView(`${p}-heavy`);
    const item = await writeItem(`${p}-item`);
    await declares(item, light, 0.5);
    await declares(item, heavy, 0.9);

    expect(await resolveDefaultViews(db, [item])).toEqual([answer(item, heavy, `view ${p}-heavy`, item)]);
  });

  it("with two parents at equal depth and weight, picks the lesser view id on every call", async () => {
    const p = fx();
    const viewA = await writeView(`${p}-a`);
    const viewB = await writeView(`${p}-b`);
    const parentA = await writeItem(`${p}-pa`);
    const parentB = await writeItem(`${p}-pb`);
    const child = await writeItem(`${p}-child`);
    await childOf(child, parentA);
    await childOf(child, parentB);
    await declares(parentA, viewA);
    await declares(parentB, viewB);
    // Postgres orders uuids bytewise, which for its lowercase rendering is
    // plain string order.
    const [lesser] = [viewA, viewB].sort();
    const lesserParent = lesser === viewA ? parentA : parentB;

    const first = await resolveDefaultViews(db, [child]);
    const second = await resolveDefaultViews(db, [child]);
    expect(first).toEqual([answer(child, lesser!, `view ${p}-${lesser === viewA ? "a" : "b"}`, lesserParent)]);
    expect(second).toEqual(first);
  });

  it("with two parents at equal depth and weight declaring the same view, names the lesser declaring node on every call", async () => {
    const p = fx();
    const view = await writeView(`${p}-v`);
    const parentA = await writeItem(`${p}-pa`);
    const parentB = await writeItem(`${p}-pb`);
    const child = await writeItem(`${p}-child`);
    await childOf(child, parentA);
    await childOf(child, parentB);
    await declares(parentA, view, 1);
    await declares(parentB, view, 1);
    // Same view, same depth, same weight: only declared_by separates the two
    // candidate rows, and Postgres's sort is not stable.
    const [lesserParent] = [parentA, parentB].sort();

    for (let i = 0; i < 5; i += 1) {
      expect(await resolveDefaultViews(db, [child])).toEqual([answer(child, view, `view ${p}-v`, lesserParent!)]);
    }
  });

  it("terminates on a two-node child_of cycle, answering null when nothing in it declares and the declaration when one does", async () => {
    const p = fx();
    const a = await writeItem(`${p}-a`);
    const b = await writeItem(`${p}-b`);
    const start = await writeItem(`${p}-start`);
    await childOf(start, a);
    await childOf(a, b);
    await childOf(b, a);

    expect(await resolveDefaultViews(db, [start, a])).toEqual([none(start), none(a)]);

    const view = await writeView(`${p}-v`);
    await declares(b, view);
    expect(await resolveDefaultViews(db, [start, a, b])).toEqual([
      answer(start, view, `view ${p}-v`, b),
      answer(a, view, `view ${p}-v`, b),
      answer(b, view, `view ${p}-v`, b),
    ]);
  });

  it("stops at the depth bound: a declaration MAX_RESOLVE_DEPTH hops up is found, one hop further is not", async () => {
    const p = fx();
    // n0 child_of n1 child_of ... child_of n(MAX+1): the top is MAX+1 hops
    // from n0 and exactly MAX hops from n1.
    const count = MAX_RESOLVE_DEPTH + 2;
    const written = await upsertNodes(
      db,
      run,
      Array.from({ length: count }, (_, i) => ({ nodeType: "work_item", sourceSystem: SRC, externalId: `${p}-n${i}`, title: `n${i}`, content: "", metadata: { status: "open", priority: 2 } })),
    );
    const idOf = new Map(written.rows.map((r) => [r.externalId, r.id]));
    const chain = Array.from({ length: count }, (_, i) => idOf.get(`${p}-n${i}`)!);
    await upsertEdges(
      db,
      run,
      chain.slice(0, -1).map((id, i) => ({ srcId: id, dstId: chain[i + 1]!, edgeType: CHILD_OF_EDGE_TYPE, sourceSystem: SRC })),
    );
    const top = await writeView(`${p}-top`);
    await declares(chain[count - 1]!, top);

    expect(await resolveDefaultViews(db, [chain[0]!, chain[1]!])).toEqual([none(chain[0]!), answer(chain[1]!, top, `view ${p}-top`, chain[count - 1]!)]);
  });

  it("rejects an empty array, more than MAX_RESOLVE_IDS ids, and a malformed id before any SQL runs", async () => {
    let executed = 0;
    const spy = {
      execute: async () => {
        executed += 1;
        return { rows: [] };
      },
    } as unknown as Database;
    await expect(resolveDefaultViews(spy, [])).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(resolveDefaultViews(spy, Array.from({ length: MAX_RESOLVE_IDS + 1 }, () => NO_NODE_ID))).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(resolveDefaultViews(spy, ["not-a-uuid"])).rejects.toBeInstanceOf(InvalidLookupIdError);
    expect(executed).toBe(0);
  });

  it("buildResolveDefaultViewsQuery is pure", () => {
    const dialect = new PgDialect();
    const a = dialect.sqlToQuery(buildResolveDefaultViewsQuery([NO_NODE_ID]));
    const b = dialect.sqlToQuery(buildResolveDefaultViewsQuery([NO_NODE_ID]));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });
});
