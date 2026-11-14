import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeIngestRun, openIngestRun, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import type { RunHerdrJson } from "../herdr-session.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";
import { reviewSessionPrompt } from "./review-session.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;
let checkout: string;

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const PROJECT = `rs-${TAG}`;
const id = (n: string) => `rs${TAG}-${n}`;
const EXTERNAL_IDS = [`project:${PROJECT}`, ...["card", "nopane", "plain", "bad"].map(id)];
const SOCKET = "/tmp/herdr-test.sock";

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  checkout = mkdtempSync(path.join(tmpdir(), "review-session-"));
  run = await openIngestRun(db, "beads", { actor: "review-session-suite" });
  const item = (ext: string, metadata: Record<string, unknown>) => ({
    nodeType: "work_item",
    sourceSystem: "beads",
    externalId: ext,
    title: `title of ${ext}`,
    content: "| a | b |\n|---|---|\n| 1 | 2 |",
    metadata: { project: PROJECT, status: "open", priority: 2, issue_type: "task", labels: ["review"], ...metadata },
  });
  await upsertNodes(db, run, [
    { nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${PROJECT}`, title: PROJECT, content: "", metadata: { project: PROJECT, path: checkout } },
    item(id("card"), {
      review: { images: [], pane: "w1:p2", socket: SOCKET, summary: "Which migration?", question: "Which migration?", options: [{ id: "A", label: "Keep", risk: "slow" }, { id: "B", label: "Skip" }], recommend: "A" },
    }),
    item(id("nopane"), { review: { images: [], pane: null, summary: "Header ok?" } }),
    item(id("plain"), { labels: ["frontend"] }),
    item(id("bad"), { review: { images: "nope", pane: null, summary: "x" } }),
  ]);
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, EXTERNAL_IDS)));
  await db.delete(ingestRuns).where(eq(ingestRuns.id, run.id));
  await pool.end();
  rmSync(checkout, { recursive: true, force: true });
});

const createCaller = createCallerFactory(appRouter);

function setup(options: { fail?: (args: readonly string[]) => Error | undefined; context?: Partial<Context> } = {}) {
  const calls: { args: string[]; socket: string }[] = [];
  const herdrJson: RunHerdrJson = async (args, socket) => {
    calls.push({ args: [...args], socket });
    const failure = options.fail?.(args);
    if (failure) throw failure;
    const [group, verb] = args;
    if (group === "pane" && verb === "get") return { pane: { pane_id: args[2], tab_id: "w1:t3" } };
    if (group === "workspace" && verb === "list") return { workspaces: [{ workspace_id: "w5", label: "reviews" }] };
    if (group === "tab" && verb === "create") return { tab: { tab_id: "w5:t2" }, root_pane: { pane_id: "w5:p2" } };
    return {};
  };
  const caller = createCaller({ db, herdrJson, herdrSocket: "/tmp/server-herdr.sock", ...options.context });
  return { caller, calls };
}

describe("reviewSession focus", () => {
  it("brings the requesting agent's tab to the front through the review's own socket", async () => {
    const { caller, calls } = setup();
    expect(await caller.reviewSession({ project: PROJECT, item: id("card"), mode: "focus" })).toEqual({ ok: true, mode: "focus", tab: "w1:t3", pane: "w1:p2" });
    expect(calls.map((c) => c.args)).toEqual([["pane", "get", "w1:p2"], ["tab", "focus", "w1:t3"]]);
    expect(calls.every((c) => c.socket === SOCKET)).toBe(true);
  });

  it("reports a gone pane as data", async () => {
    const { caller } = setup({ fail: (a) => (a[0] === "pane" ? new Error("pane w1:p2 not found") : undefined) });
    expect(await caller.reviewSession({ project: PROJECT, item: id("card"), mode: "focus" })).toEqual({ ok: false, mode: "focus", reason: "pane w1:p2 not found" });
  });

  it("refuses a review with no recorded pane, before any command", async () => {
    const { caller, calls } = setup();
    await expect(caller.reviewSession({ project: PROJECT, item: id("nopane"), mode: "focus" })).rejects.toThrow(/no herdr pane/);
    expect(calls).toHaveLength(0);
  });
});

describe("reviewSession open", () => {
  it("opens a tab in the reviews workspace, in the checkout, primed with the card", async () => {
    const { caller, calls } = setup();
    expect(await caller.reviewSession({ project: PROJECT, item: id("card"), mode: "open" })).toEqual({ ok: true, mode: "open", tab: "w5:t2", pane: "w5:p2" });
    expect(calls[1]!.args.slice(0, 6)).toEqual(["tab", "create", "--workspace", "w5", "--cwd", checkout]);
    const file = /^Read (\S+) and do/.exec(calls.find((c) => c.args[1] === "start")!.args.at(-1)!)![1]!;
    const prompt = readFileSync(file, "utf8");
    expect(prompt).toContain("Question: Which migration?");
    expect(prompt).toContain("- A: Keep (recommended) Risk: slow");
    expect(prompt).toContain(`bd show ${id("card")}`);
    expect(calls.every((c) => c.socket === "/tmp/server-herdr.sock")).toBe(true);
  });

  it("refuses on a read-only server, without a herdr socket, and for non-reviews", async () => {
    await expect(setup({ context: { readOnly: true } }).caller.reviewSession({ project: PROJECT, item: id("card"), mode: "open" })).rejects.toThrow(/read-only/);
    await expect(setup({ context: { herdrSocket: null } }).caller.reviewSession({ project: PROJECT, item: id("card"), mode: "open" })).rejects.toThrow(/No herdr session/);
    await expect(setup().caller.reviewSession({ project: PROJECT, item: id("plain"), mode: "open" })).rejects.toThrow(/not a review/);
    await expect(setup().caller.reviewSession({ project: PROJECT, item: id("bad"), mode: "open" })).rejects.toThrow(/not a review/);
    await expect(setup().caller.reviewSession({ project: `none-${TAG}`, item: id("card"), mode: "open" })).rejects.toThrow(/no checkout registered/);
    await expect(setup({ context: { herdrJson: undefined } }).caller.reviewSession({ project: PROJECT, item: id("card"), mode: "focus" })).rejects.toThrow(/no herdr runner/);
  });

  it("refuses both modes naming herdr when it is missing from PATH, even for an unknown project, before any command", async () => {
    for (const mode of ["focus", "open"] as const) {
      const { caller, calls } = setup({ context: { missingBinaries: ["herdr"] } });
      const err = await caller.reviewSession({ project: `none-${TAG}`, item: id("card"), mode }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "PRECONDITION_FAILED", message: "herdr is unavailable on this server: not found on PATH" });
      expect(calls).toHaveLength(0);
    }
  });

  it("reports an agent that won't start as data", async () => {
    const { caller } = setup({ fail: (a) => (a[0] === "agent" && a[1] === "start" ? new Error("unknown agent kind") : undefined) });
    expect(await caller.reviewSession({ project: PROJECT, item: id("card"), mode: "open" })).toEqual({ ok: false, mode: "open", reason: "unknown agent kind" });
  });
});

describe("reviewSessionPrompt", () => {
  it("reads a legacy review as a question-only card and cuts long evidence", () => {
    const text = reviewSessionPrompt({ project: "p", externalId: "p-1", title: "t", description: "x".repeat(5000), review: { images: [], pane: null, summary: "Does the grid line up?\nmore" } });
    expect(text).toContain("Question: Does the grid line up?");
    expect(text).not.toContain("Options:");
    expect(text).toContain("(cut; `bd show p-1` has all of it)");
    expect(text).toContain("Don't decide the review");
  });
});
