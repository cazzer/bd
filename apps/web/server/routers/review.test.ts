// board-visual-reviews 3.3: `reviewDecision` through the real router chain
// (Zod -> refusals -> registry and item reads -> writer -> watcher wake),
// with a fake writer runner and a fake watcher. The writer's argv is proven
// in review-writer.test.ts; here the router decides whether it runs at all,
// where, and what comes back. Fixtures are `beads` rows with this file's own
// project keys and external ids, deleted by exactly those keys; nothing
// asserts a store-wide count.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeIngestRun, openIngestRun, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeadsWatcher } from "../beads-watcher.js";
import type { Context } from "../context.js";
import { createReviewWriter, type RunBd } from "../review-writer.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let beadsRun: IngestRunHandle;
let checkout: string;

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const PROJECT = `rv-${TAG}`;
const UNREGISTERED = `rvu-${TAG}`;
const MISSING_DIR = `rvm-${TAG}`;
const id = (n: string) => `rv${TAG}-${n}`;
const EXTERNAL_IDS = [`project:${PROJECT}`, `project:${MISSING_DIR}`, id("r1"), id("r2"), id("plain"), id("closed"), id("orphan"), id("missing")];

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  checkout = mkdtempSync(path.join(tmpdir(), "review-router-"));
  const notADir = path.join(checkout, "not-a-dir");
  writeFileSync(notADir, "");
  beadsRun = await openIngestRun(db, "beads", { actor: "review-router-suite" });
  const review = { images: [], pane: "w1:p2", summary: "header and grid" };
  const item = (ext: string, project: string, metadata: Record<string, unknown>) => ({
    nodeType: "work_item",
    sourceSystem: "beads",
    externalId: ext,
    title: ext,
    content: "",
    metadata: { project, status: "open", priority: 2, issue_type: "task", ...metadata },
  });
  await upsertNodes(db, beadsRun, [
    { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${PROJECT}`, title: PROJECT, content: "", metadata: { project: PROJECT, path: checkout } },
    { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${MISSING_DIR}`, title: MISSING_DIR, content: "", metadata: { project: MISSING_DIR, path: notADir } },
    item(id("r1"), PROJECT, { labels: ["review"], review }),
    item(id("r2"), PROJECT, { labels: ["review", "review:changes"], review }),
    item(id("plain"), PROJECT, { labels: ["frontend"] }),
    item(id("closed"), PROJECT, { labels: ["review"], review, status: "closed" }),
    item(id("orphan"), UNREGISTERED, { labels: ["review"], review }),
    item(id("missing"), MISSING_DIR, { labels: ["review"], review }),
  ]);
});

afterAll(async () => {
  await closeIngestRun(db, beadsRun);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, EXTERNAL_IDS)));
  await db.delete(ingestRuns).where(eq(ingestRuns.id, beadsRun.id));
  await pool.end();
  rmSync(checkout, { recursive: true, force: true });
});

const createCaller = createCallerFactory(appRouter);

function setup(opts: { fail?: (args: readonly string[]) => string | undefined; db?: Database; readOnly?: boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runBd: RunBd = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const message = opts.fail?.(args);
    if (message !== undefined) throw new Error(message);
    return "";
  };
  const wake = vi.fn((_project: string) => true);
  const ctx: Context = {
    db: opts.db ?? db,
    reviewWriter: createReviewWriter({ runBd }),
    watcher: { wake } as unknown as BeadsWatcher,
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
  };
  return { caller: createCaller(ctx), calls, wake };
}

/** Throws on any property access — proves the refusal came before any database call. */
function poisonedDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("ctx.db should never be touched for a refused decision");
      },
    },
  ) as Database;
}

describe("reviewDecision", () => {
  it("accept runs bd in the registered checkout and wakes the watcher once", async () => {
    const { caller, calls, wake } = setup();
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "  looks right  " });

    expect(result).toEqual({ ok: true, decision: "accept", item: id("r1"), written: ["comment", "close", "remove-changes-label"], notified: null });
    expect(calls.map((c) => c.cwd)).toEqual([checkout, checkout, checkout]);
    expect(calls[0]!.args).toEqual(["comments", "add", id("r1"), "Accepted: looks right"]);
    expect(calls[1]!.args[0]).toBe("close");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(PROJECT);
  });

  it("changes comments and adds review:changes in the checkout, and wakes the watcher once", async () => {
    const { caller, calls, wake } = setup();
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: `"; rm -rf ~ #` });

    expect(result).toMatchObject({ ok: true, written: ["comment", "add-changes-label"] });
    expect(calls).toEqual([
      { args: ["comments", "add", id("r2"), `Changes requested: "; rm -rf ~ #`], cwd: checkout },
      { args: ["update", id("r2"), "--add-label", "review:changes"], cwd: checkout },
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unregistered project", { project: UNREGISTERED, item: id("orphan") }, "NOT_FOUND", UNREGISTERED],
    ["an item not in the project", { project: PROJECT, item: id("nope") }, "NOT_FOUND", id("nope")],
    ["an item that is not a review", { project: PROJECT, item: id("plain") }, "PRECONDITION_FAILED", "not a review"],
    ["a closed review", { project: PROJECT, item: id("closed") }, "CONFLICT", "already closed"],
    ["a checkout path that is not a directory", { project: MISSING_DIR, item: id("missing") }, "PRECONDITION_FAILED", "not-a-dir"],
  ])("refuses %s before running anything", async (_name, target, code, mentions) => {
    const { caller, calls, wake } = setup();
    const err = await caller.reviewDecision({ ...target, decision: "accept", message: "" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code });
    expect((err as Error).message).toContain(mentions);
    expect(calls).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("refuses every decision on a read-only server without touching the database", async () => {
    const { caller, calls } = setup({ db: poisonedDb(), readOnly: true });
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("BRAIN_READ_ONLY"),
    });
    expect(calls).toEqual([]);
  });

  it("refuses without a review writer, before the database", async () => {
    const caller = createCaller({ db: poisonedDb() });
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it.each(["", "   \n "])("refuses changes with message %j", async (message) => {
    const { caller, calls } = setup({ db: poisonedDb() });
    const err = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "changes", message }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect((err as Error).message).toContain("message");
    expect(calls).toEqual([]);
  });

  it.each([
    ["an item id that starts with '-'", { item: "-rf" }],
    ["a message with NUL", { message: "a\u0000b" }],
    ["an over-long message", { message: "x".repeat(5000) }],
  ])("refuses %s at validation", async (_name, over) => {
    const { caller, calls } = setup({ db: poisonedDb() });
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "", ...over })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toEqual([]);
  });

  it("returns a failing close as a partial write, as data, and still wakes the watcher", async () => {
    const { caller, wake } = setup({ fail: (args) => (args[0] === "close" ? "bd close failed: database is locked" : undefined) });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "ok" });

    expect(result).toEqual({ ok: false, decision: "accept", item: id("r1"), written: ["comment"], error: "bd close failed: database is locked", partial: true, notified: null });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not wake the watcher when nothing was written", async () => {
    const { caller, wake } = setup({ fail: () => "bd comments failed: no issue found" });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "changes", message: "fix" });

    expect(result).toMatchObject({ ok: false, written: [], partial: false, error: "bd comments failed: no issue found" });
    expect(wake).not.toHaveBeenCalled();
  });
});
