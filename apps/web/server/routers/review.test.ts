// board-visual-reviews 3.3: `reviewDecision` through the real router chain
// (Zod -> refusals -> registry and item reads -> writer -> watcher wake),
// with a fake writer runner and a fake watcher. The writer's argv is proven
// in review-writer.test.ts; here the router decides whether it runs at all,
// where, and what comes back. Fixtures are `beads` rows with this file's own
// project keys and external ids, deleted by exactly those keys; nothing
// asserts a store-wide count.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeIngestRun, mergeNodes, openIngestRun, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeadsWatcher } from "../beads-watcher.js";
import type { Context } from "../context.js";
import { BdUncertainError, createReviewWriter, NOTIFY_NO_PANE, NOTIFY_NOT_WRITTEN, type RunBd, type RunHerdr } from "../review-writer.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let beadsRun: IngestRunHandle;
let agentRun: IngestRunHandle;
let checkout: string;
let sockDir: string;
let socketServer: Server;
/** A real unix socket: the writer prompts only through a recorded socket that exists. */
let SOCKET: string;

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const PROJECT = `rv-${TAG}`;
const UNREGISTERED = `rvu-${TAG}`;
const MISSING_DIR = `rvm-${TAG}`;
const FORGED = `rvf-${TAG}`;
const id = (n: string) => `rv${TAG}-${n}`;
const EXTERNAL_IDS = [
  `project:${PROJECT}`,
  `project:${MISSING_DIR}`,
  `project:${FORGED}`,
  ...["r1", "r2", "plain", "closed", "orphan", "missing", "forged", "fx", "fy"].map(id),
];

beforeAll(async () => {
  // The writer logs every notification it could not make; keep the run quiet.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sockDir = mkdtempSync(path.join(tmpdir(), "rr-sock-"));
  SOCKET = path.join(sockDir, "h.sock");
  socketServer = createServer();
  await new Promise<void>((resolve) => socketServer.listen(SOCKET, resolve));
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  checkout = mkdtempSync(path.join(tmpdir(), "review-router-"));
  const notADir = path.join(checkout, "not-a-dir");
  writeFileSync(notADir, "");
  beadsRun = await openIngestRun(db, "beads", { actor: "review-router-suite" });
  // Any non-beads run stands in for brain_write's `agent` run; not `agent` itself, which apps/mcp's suite deletes when empty.
  agentRun = await openIngestRun(db, `agent-review-test-${TAG}`, { actor: "review-router-suite" });
  const review = { images: [], pane: "w1:p2", summary: "header and grid" };
  const item = (ext: string, project: string, metadata: Record<string, unknown> = {}) => ({
    nodeType: "work_item",
    sourceSystem: "beads",
    externalId: ext,
    title: ext,
    content: "",
    metadata: { project, status: "open", priority: 2, issue_type: "task", labels: ["review"], review, ...metadata },
  });
  const registry = (key: string, dir: string) => ({ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${key}`, title: key, content: "", metadata: { project: key, path: dir } });
  const written = await upsertNodes(db, beadsRun, [
    registry(PROJECT, checkout),
    registry(MISSING_DIR, notADir),
    item(id("r1"), PROJECT),
    item(id("r2"), PROJECT, { labels: ["review", "review:changes"] }),
    item(id("plain"), PROJECT, { labels: ["frontend"] }),
    item(id("closed"), PROJECT, { status: "closed" }),
    item(id("orphan"), UNREGISTERED),
    item(id("missing"), MISSING_DIR),
    item(id("forged"), FORGED),
    item(id("fx"), PROJECT),
    item(id("fy"), PROJECT),
  ]);
  // A registry-shaped node an agent wrote (brain_write's run), pointing at a real directory.
  await upsertNodes(db, agentRun, [registry(FORGED, checkout)]);
  const nodeId = new Map(written.rows.map((r) => [r.externalId, r.id]));
  await mergeNodes(db, nodeId.get(id("fx"))!, nodeId.get(id("fy"))!, beadsRun);
});

afterAll(async () => {
  await closeIngestRun(db, beadsRun);
  await closeIngestRun(db, agentRun);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, EXTERNAL_IDS)));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [beadsRun.id, agentRun.id]));
  await pool.end();
  rmSync(checkout, { recursive: true, force: true });
  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  rmSync(sockDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const createCaller = createCallerFactory(appRouter);

interface SetupOptions {
  /** Throws for a command (show included). */
  fail?: (args: readonly string[]) => Error | undefined;
  /** The tracker's record for `bd show`; an open review of the asked id by default. */
  show?: (id: string) => Record<string, unknown>;
  /** Called for each command before it answers; may hold it. */
  hold?: (args: readonly string[]) => Promise<void> | undefined;
  /** Rejects the herdr call with this error. */
  herdrFails?: Error;
  db?: Database;
  readOnly?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const herdrCalls: string[][] = [];
  const order: string[] = [];
  const runHerdr: RunHerdr = async (args, socket) => {
    order.push("herdr");
    herdrCalls.push([...args, `socket=${socket}`]);
    if (opts.herdrFails) throw opts.herdrFails;
  };
  const runBd: RunBd = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    await opts.hold?.(args);
    const err = opts.fail?.(args);
    if (err) throw err;
    if (args[0] === "show") return JSON.stringify([{ id: args[1], status: "open", labels: ["review"], ...opts.show?.(args[1]!) }]);
    return "";
  };
  const wake = vi.fn((_project: string) => {
    order.push("wake");
    return true;
  });
  const ctx: Context = {
    db: opts.db ?? db,
    reviewWriter: createReviewWriter({ runBd, runHerdr }),
    watcher: { wake } as unknown as BeadsWatcher,
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
  };
  const writes = () => calls.filter((c) => c.args[0] !== "show");
  return { caller: createCaller(ctx), calls, writes, wake, herdrCalls, order };
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
  it("accept reads the record, then writes in the registered checkout, and wakes the watcher once", async () => {
    const { caller, calls, wake } = setup();
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "  looks right  " });

    // The store's copy names pane w1:p2, but the tracker's record (the fake `bd show`) names none: no prompt.
    expect(result).toEqual({ ok: true, decision: "accept", item: id("r1"), written: ["comment", "remove-changes-label", "close"], notified: { ok: false, reason: NOTIFY_NO_PANE } });
    expect(calls.map((c) => c.args[0])).toEqual(["show", "comments", "update", "close"]);
    expect(calls.every((c) => c.cwd === checkout)).toBe(true);
    expect(calls[1]!.args).toEqual(["comments", "add", id("r1"), "Accepted: looks right"]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(PROJECT);
  });

  it("changes comments and adds review:changes in the checkout, and wakes the watcher once", async () => {
    const { caller, writes, wake } = setup();
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: `"; rm -rf ~ #` });

    expect(result).toMatchObject({ ok: true, written: ["comment", "add-changes-label"] });
    expect(writes()).toEqual([
      { args: ["comments", "add", id("r2"), `Changes requested: "; rm -rf ~ #`], cwd: checkout },
      { args: ["update", id("r2"), "--add-label", "review:changes"], cwd: checkout },
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unregistered project", { project: UNREGISTERED, item: id("orphan") }, "NOT_FOUND", UNREGISTERED],
    ["a registry node an agent wrote", { project: FORGED, item: id("forged") }, "NOT_FOUND", FORGED],
    ["an item not in the project", { project: PROJECT, item: id("nope") }, "NOT_FOUND", id("nope")],
    ["an item merged into another bead", { project: PROJECT, item: id("fx") }, "PRECONDITION_FAILED", id("fy")],
    ["an item that is not a review", { project: PROJECT, item: id("plain") }, "PRECONDITION_FAILED", "not a review"],
    ["a closed review", { project: PROJECT, item: id("closed") }, "CONFLICT", "already closed"],
    ["a checkout path that is not a directory", { project: MISSING_DIR, item: id("missing") }, "PRECONDITION_FAILED", "not-a-dir"],
  ])("refuses %s before running any command", async (_name, target, code, mentions) => {
    const { caller, calls, wake } = setup();
    const err = await caller.reviewDecision({ ...target, decision: "accept", message: "" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code });
    expect((err as Error).message).toContain(mentions);
    expect(calls).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it.each([
    ["is closed", { status: "closed" }, "CONFLICT"],
    ["is not labelled review", { labels: ["frontend"] }, "PRECONDITION_FAILED"],
    ["is another issue", { id: "zz-1" }, "PRECONDITION_FAILED"],
  ])("refuses when the tracker's own record %s, writing nothing", async (_name, record, code) => {
    const { caller, calls, writes, wake } = setup({ show: () => record });
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "" })).rejects.toMatchObject({ code });
    expect(calls.map((c) => c.args[0])).toEqual(["show"]);
    expect(writes()).toEqual([]);
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

  it("refuses a decision on an item whose previous decision is still being written", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    const { caller, wake } = setup({
      hold: (args) => {
        if (args[0] !== "comments") return undefined;
        entered();
        return new Promise<void>((r) => (release = r));
      },
    });
    const first = caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "first" });
    await reached;
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "second" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already being written"),
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(wake).toHaveBeenCalledTimes(1);
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
    ["a message with ESC (terminal escape)", { message: "a\u001b[2Jb" }],
    ["a message with a carriage return", { message: "a\rb" }],
    ["a message with DEL", { message: "a\u007fb" }],
    ["a message with a right-to-left override", { message: "a\u202eb" }],
    ["a message with a bidi isolate", { message: "a\u2067b" }],
    ["a message with a C1 control (U+0085)", { message: "a\u0085b" }],
    ["a message with a C1 control (U+009B, CSI)", { message: "a\u009b31mb" }],
    ["a message with a C1 control (U+0080)", { message: "a\u0080b" }],
    ["an over-long message", { message: "x".repeat(5000) }],
  ])("refuses %s at validation", async (_name, over) => {
    const { caller, calls } = setup({ db: poisonedDb() });
    await expect(caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "", ...over })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toEqual([]);
  });

  it("allows newline and tab in a message", async () => {
    const { caller, writes } = setup();
    await caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "one\n\ttwo" });
    expect(writes()[0]!.args[3]).toBe("Changes requested: one\n\ttwo");
  });

  it("passes the notification through: the tracker record's pane is prompted", async () => {
    const { caller, herdrCalls, order } = setup({ show: () => ({ metadata: { review: { pane: "w5:p5", socket: SOCKET, images: [], summary: "" } } }) });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "tighten the grid" });

    expect(result).toEqual({ ok: true, decision: "changes", item: id("r2"), written: ["comment", "add-changes-label"], notified: { ok: true, pane: "w5:p5" } });
    expect(herdrCalls).toEqual([["agent", "prompt", "w5:p5", `Review ${id("r2")} changes requested: tighten the grid`, `socket=${SOCKET}`]]);
    // The board is woken before herdr runs, so it never waits on the notification.
    expect(order).toEqual(["wake", "herdr"]);
  });

  it("a failed notification is data: the decision still succeeds", async () => {
    const { caller, wake } = setup({
      show: () => ({ metadata: { review: { pane: "w9:p9", socket: SOCKET } } }),
      herdrFails: new Error("agent target w9:p9 not found (agent_not_found)"),
    });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "" });

    expect(result).toMatchObject({ ok: true, written: ["comment", "remove-changes-label", "close"], notified: { ok: false, reason: "agent target w9:p9 not found (agent_not_found)" } });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("returns a failing close as a partial write, as data, and still wakes the watcher", async () => {
    const { caller, wake } = setup({ fail: (args) => (args[0] === "close" ? new Error("bd close failed: database is locked") : undefined) });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r1"), decision: "accept", message: "ok" });

    expect(result).toEqual({
      ok: false,
      decision: "accept",
      item: id("r1"),
      written: ["comment", "remove-changes-label"],
      error: "bd close failed: database is locked",
      partial: true,
      notified: { ok: false, reason: NOTIFY_NOT_WRITTEN },
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("returns a timed-out step as uncertain and wakes the watcher", async () => {
    const { caller, wake } = setup({ fail: (args) => (args[0] === "comments" ? new BdUncertainError("bd comments timed out after 30 s") : undefined) });
    const result = await caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "fix" });

    expect(result).toMatchObject({ ok: false, written: [], uncertain: "comment", partial: false });
    expect(result.error).toContain("may have been written");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("wakes the watcher when a write command failed, but not when only bd show did", async () => {
    const commentFails = setup({ fail: (args) => (args[0] === "comments" ? new Error("bd comments failed: no issue found") : undefined) });
    await expect(commentFails.caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "fix" })).resolves.toMatchObject({
      ok: false,
      written: [],
      partial: false,
    });
    expect(commentFails.wake).toHaveBeenCalledTimes(1);

    const showFails = setup({ fail: (args) => (args[0] === "show" ? new Error("bd not found on PATH") : undefined) });
    await expect(showFails.caller.reviewDecision({ project: PROJECT, item: id("r2"), decision: "changes", message: "fix" })).resolves.toMatchObject({
      ok: false,
      written: [],
      error: "bd not found on PATH",
    });
    expect(showFails.wake).not.toHaveBeenCalled();
  });
});
