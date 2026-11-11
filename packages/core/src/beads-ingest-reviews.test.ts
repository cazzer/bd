// DB-backed tests for review data in the beads loader (board-visual-reviews,
// task 1.3): `ingestBeadsCheckout` fetches `bd comments` for review beads
// through the injectable runner and lands the thread on the work item. Kept
// apart from beads-ingest.test.ts, which another change is editing.
// Isolation: a unique bead-id prefix and project keys; teardown deletes
// exactly this suite's rows and runs. No assertion reads a store-wide count.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { type BeadsComment, type BeadsIssue } from "./beads.js";
import { ingestBeadsCheckout, type IngestBeadsCheckoutResult } from "./beads-ingest.js";
import { MAX_REVIEW_COMMENT_LENGTH, MAX_REVIEW_COMMENTS, MAX_REVIEW_COMMENTS_CHARS } from "./reviews.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 12);
const PREFIX = `br${SUFFIX}`;
const keyOf = (name: string) => `${name}-${SUFFIX}`;
const SCRATCH = mkdtempSync(path.join(tmpdir(), "beads-ingest-reviews-test-"));
const DIR = realpathSync(SCRATCH);

let pool: TestPool;
let db: Database;
const runIds: string[] = [];

function issue(n: number, overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return { id: `${PREFIX}-${n}`, title: `Issue ${n}`, status: "open", priority: 2, issue_type: "task", created_at: "2026-10-01T10:00:00Z", ...overrides };
}

function comment(issueId: string, n: number, text = `comment ${n}`): BeadsComment {
  return { id: n, issue_id: issueId, author: "agent", text, created_at: new Date(Date.UTC(2026, 9, 28, 10, n)).toISOString() };
}

/** A fixture `bd`: answers `list` with `issues` and `comments <id>` from `threads`, recording every call. */
function fixture(issues: BeadsIssue[], threads: Record<string, unknown>) {
  const calls: string[][] = [];
  const runBd = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "list") return JSON.stringify(issues);
    if (args[0] === "comments") {
      expect(args).toEqual(["comments", args[1], "--json"]);
      const id = args[1] as string;
      if (!(id in threads)) throw new Error(`unexpected comments call for ${id}`);
      return JSON.stringify(threads[id]);
    }
    throw new Error(`unexpected bd ${args.join(" ")}`);
  };
  return { runBd, calls };
}

async function load(project: string, issues: BeadsIssue[], threads: Record<string, unknown>): Promise<IngestBeadsCheckoutResult & { calls: string[][] }> {
  const { runBd, calls } = fixture(issues, threads);
  const result = await ingestBeadsCheckout(db, { dir: DIR, project, runBd });
  runIds.push(result.ingestRunId);
  return { ...result, calls };
}

async function rowOf(externalId: string) {
  const [row] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, externalId)));
  return row;
}

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), or(like(nodes.externalId, `${PREFIX}-%`), like(nodes.externalId, `project:%-${SUFFIX}`))));
  if (runIds.length > 0) await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("ingestBeadsCheckout reviews", () => {
  it("lands comments oldest first, reports only the commented review as changed, and fetches only review beads with comments", async () => {
    const project = keyOf("rv");
    const reviewId = `${PREFIX}-1`;
    const images = [`/home/u/.local/share/breakdown/reviews/${project}/${reviewId}/01-a.png`];
    const reviewMeta = { review: { images, pane: "w1:p1", summary: "Look at the header" } };
    const issues = (count: number) => [
      issue(1, { labels: ["review"], comment_count: count, metadata: reviewMeta }),
      issue(2, { labels: ["review"], comment_count: 0, metadata: reviewMeta }),
      issue(3, { labels: ["ui"], comment_count: 5 }),
      issue(4, { labels: ["review:changes"], comment_count: 2 }),
    ];
    const three = [comment(reviewId, 3), comment(reviewId, 1), comment(reviewId, 2)];

    const first = await load(project, issues(3), { [reviewId]: three });
    expect(first.calls.filter((c) => c[0] === "comments")).toEqual([["comments", reviewId, "--json"]]);
    expect(first.nodes.created).toBe(5);

    const row = await rowOf(reviewId);
    expect(row?.metadata).toMatchObject({ review: { images, pane: "w1:p1", summary: "Look at the header" } });
    expect((row?.metadata as { review_comments: { text: string }[] }).review_comments.map((c) => c.text)).toEqual(["comment 1", "comment 2", "comment 3"]);
    expect((await rowOf(`${PREFIX}-2`))?.metadata).not.toHaveProperty("review_comments");
    expect((await rowOf(`${PREFIX}-3`))?.metadata).not.toHaveProperty("review");

    expect(row?.metadata).toMatchObject({ review_comment_count: 3 });

    // Same comment_count: the stored thread is carried forward, no bd comments call, nothing changes.
    const same = await load(project, issues(3), {});
    expect(same.calls.filter((c) => c[0] === "comments")).toEqual([]);
    expect(same.nodes).toEqual({ created: 0, updated: 0, unchanged: 5 });
    expect(same.changed).toBe(false);

    const fourth = await load(project, issues(4), { [reviewId]: [...three, comment(reviewId, 4, "Accepted: looks right")] });
    expect(fourth.calls.filter((c) => c[0] === "comments")).toEqual([["comments", reviewId, "--json"]]);
    expect(fourth.changedNodeIds).toEqual([row?.id]);
    expect(fourth.changed).toBe(true);
    expect(fourth.nodes).toEqual({ created: 0, updated: 1, unchanged: 4 });
    expect(((await rowOf(reviewId))?.metadata as { review_comments: { text: string }[] }).review_comments.at(-1)?.text).toBe("Accepted: looks right");
  });

  it("lands a decision card as written and reports a reload unchanged", async () => {
    const project = keyOf("card");
    const reviewId = `${PREFIX}-60`;
    const card = JSON.parse(readFileSync(new URL("../../../fixtures/review-cards/before-after.expected.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const bead = [issue(60, { labels: ["review"], comment_count: 0, metadata: { review: card } })];

    const first = await load(project, bead, {});
    expect(first.nodes.created).toBe(2);
    expect((await rowOf(reviewId))?.metadata).toMatchObject({ review: card });
    // The card's key (split-review-decisions) lands with it.
    expect((await rowOf(reviewId))?.metadata).toMatchObject({ review: { key: "before-after" } });

    const again = await load(project, bead, {});
    expect(again.nodes).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(again.changed).toBe(false);
  });

  it("fails the load when bd comments does not return an array, writing nothing", async () => {
    const project = keyOf("bad");
    const reviewId = `${PREFIX}-10`;
    const { runBd } = fixture([issue(10, { labels: ["review"], comment_count: 1, metadata: { review: { summary: "s" } } })], { [reviewId]: { text: "not a list" } });
    await expect(ingestBeadsCheckout(db, { dir: DIR, project, runBd })).rejects.toThrow(`bd comments ${reviewId} --json did not return an array`);
    expect(await rowOf(reviewId)).toBeUndefined();
    expect(await rowOf(`project:${project}`)).toBeUndefined();
  });

  it("carries forward a thread whose comments were escaped, cut, and NUL-replaced, still reporting unchanged", async () => {
    const project = keyOf("carry");
    const reviewId = `${PREFIX}-40`;
    const thread = [
      { id: 1, author: "a\u0000", text: "\u0001".repeat(MAX_REVIEW_COMMENT_LENGTH), created_at: "2026-10-28T10:00:00Z" },
      { id: 2, author: null, text: "\u0001".repeat(MAX_REVIEW_COMMENT_LENGTH), created_at: "not a time" },
    ];
    const bead = [issue(40, { labels: ["review"], comment_count: 2, metadata: { review: { summary: "x\u0000" } } })];
    await load(project, bead, { [reviewId]: thread });
    const again = await load(project, bead, {});
    expect(again.calls.filter((c) => c[0] === "comments")).toEqual([]);
    expect(again.nodes).toEqual({ created: 0, updated: 0, unchanged: 2 });
  });

  it("fails the load when bd comments returns invalid JSON", async () => {
    const project = keyOf("json");
    const reviewId = `${PREFIX}-50`;
    const runBd = async (args: readonly string[]) => (args[0] === "list" ? JSON.stringify([issue(50, { labels: ["review"], comment_count: 1 })]) : "{not json");
    await expect(ingestBeadsCheckout(db, { dir: DIR, project, runBd })).rejects.toThrow(`bd comments ${reviewId} --json returned invalid JSON`);
    expect(await rowOf(reviewId)).toBeUndefined();
  });

  it("propagates a failing comments call", async () => {
    const project = keyOf("fail");
    const reviewId = `${PREFIX}-20`;
    const runBd = async (args: readonly string[]) => {
      if (args[0] === "list") return JSON.stringify([issue(20, { labels: ["review"], comment_count: 1 })]);
      throw new Error("bd comments exploded");
    };
    await expect(ingestBeadsCheckout(db, { dir: DIR, project, runBd })).rejects.toThrow("bd comments exploded");
    expect(await rowOf(reviewId)).toBeUndefined();
  });

  it("loads a thread of MAX_REVIEW_COMMENTS full-length comments within the comment budget", async () => {
    const project = keyOf("big");
    const reviewId = `${PREFIX}-30`;
    const thread = Array.from({ length: MAX_REVIEW_COMMENTS }, (_, i) => comment(reviewId, i, "x".repeat(MAX_REVIEW_COMMENT_LENGTH)));
    const result = await load(project, [issue(30, { labels: ["review"], comment_count: thread.length, metadata: { review: { summary: "big" } } })], { [reviewId]: thread });
    expect(result.nodes.created).toBe(2);
    const stored = ((await rowOf(reviewId))?.metadata as { review_comments: { id: string }[] }).review_comments;
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(MAX_REVIEW_COMMENTS_CHARS);
    expect(stored.at(-1)?.id).toBe(String(MAX_REVIEW_COMMENTS - 1));
  });
});
