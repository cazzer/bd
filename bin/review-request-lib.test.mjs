import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { describe, it } from "node:test";
import {
  USAGE,
  boardLink,
  chooseReview,
  copiedName,
  findProject,
  paneFrom,
  parseArgs,
  parseJsonOutput,
  requestReview,
  reviewMetadata,
} from "./review-request-lib.mjs";

const BREAKDOWN_ROOT = "/opt/breakdown";
const ITEM = "scr-1";
const REVIEW = "scr-1.1";

describe("parseArgs", () => {
  it("accepts an item, a summary, and images", () => {
    assert.deepEqual(parseArgs(["scr-1", "--summary", "header", "a.png", "b.png"]), {
      args: { itemId: "scr-1", summary: "header", boardUrl: "http://localhost:5173", images: ["a.png", "b.png"] },
    });
  });
  it("accepts --summary=x and --board-url", () => {
    assert.deepEqual(parseArgs(["--summary=x", "scr-1", "a.png", "--board-url", "https://board.test/app"]), {
      args: { itemId: "scr-1", summary: "x", boardUrl: "https://board.test/app", images: ["a.png"] },
    });
  });
  it("returns help", () => {
    assert.deepEqual(parseArgs(["--help"]), { help: true });
  });
  it("refuses a missing or blank summary", () => {
    assert.match(parseArgs(["scr-1", "a.png"]).error, /--summary is required/);
    assert.match(parseArgs(["scr-1", "--summary", "  ", "a.png"]).error, /--summary is required/);
  });
  it("refuses an over-long summary", () => {
    assert.match(parseArgs(["scr-1", "--summary", "x".repeat(2001), "a.png"]).error, /longer than 2000/);
  });
  it("refuses zero and 21 images", () => {
    assert.match(parseArgs(["scr-1", "--summary", "s"]).error, /at least one image/);
    const many = Array.from({ length: 21 }, (_, i) => `${i}.png`);
    assert.match(parseArgs(["scr-1", "--summary", "s", ...many]).error, /at most 20 images, got 21/);
  });
  it("refuses a bad item id and a missing one", () => {
    assert.match(parseArgs(["scr 1", "--summary", "s", "a.png"]).error, /not an issue id/);
    assert.match(parseArgs(["scr;rm", "--summary", "s", "a.png"]).error, /not an issue id/);
    assert.match(parseArgs(["--summary", "s"]).error, /missing <item-id>/);
  });
  it("refuses a non-http board url and unknown options", () => {
    assert.match(parseArgs(["scr-1", "--summary", "s", "--board-url", "file:///x", "a.png"]).error, /http\(s\) URL/);
    assert.match(parseArgs(["scr-1", "--summary", "s", "--board-url", "nope", "a.png"]).error, /http\(s\) URL/);
    assert.ok(parseArgs(["scr-1", "--summary", "s", "--bogus", "a.png"]).error);
  });
});

describe("helpers", () => {
  it("copiedName numbers from 01 and sanitizes the basename", () => {
    assert.equal(copiedName(0, "shots/a.png"), "01-a.png");
    assert.equal(copiedName(11, "/x/my shot (1).PNG"), "12-my_shot__1_.PNG");
  });
  it("boardLink encodes and tolerates a trailing slash", () => {
    assert.equal(
      boardLink("http://localhost:5173/", "my proj", "a&b"),
      "http://localhost:5173/board?project=my%20proj&item=a%26b",
    );
  });
  it("findProject matches through a symlink", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rr-find-"));
    const real = path.join(tmp, "real");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(tmp, "link"));
    const projects = [
      { key: "other", path: path.join(tmp, "missing") },
      { key: "scratch", path: path.join(tmp, "link") },
    ];
    assert.equal(findProject(projects, realpathSync(real))?.key, "scratch");
    assert.equal(findProject(projects, path.join(tmp, "elsewhere")), null);
  });
  it("chooseReview picks the newest and counts", () => {
    assert.equal(chooseReview([]), null);
    const chosen = chooseReview([
      { id: "a", created_at: "2026-10-01T00:00:00Z" },
      { id: "b", created_at: "2026-10-03T00:00:00Z" },
      { id: "c", created_at: "2026-10-02T00:00:00Z" },
    ]);
    assert.equal(chosen.review.id, "b");
    assert.equal(chosen.count, 3);
  });
  it("reviewMetadata keeps other keys, replaces review, omits a null pane", () => {
    const existing = { team: "x", review: { images: ["old"], pane: "p0", summary: "old" } };
    assert.deepEqual(reviewMetadata(existing, { images: ["n"], pane: null, summary: "s" }), {
      team: "x",
      review: { images: ["n"], summary: "s" },
    });
    assert.deepEqual(reviewMetadata(undefined, { images: ["n"], pane: "p1", summary: "s" }), {
      review: { images: ["n"], pane: "p1", summary: "s" },
    });
    assert.deepEqual(reviewMetadata('{"team":"y"}', { images: [], pane: null, summary: "s" }), {
      team: "y",
      review: { images: [], summary: "s" },
    });
  });
  it("paneFrom accepts pane ids only", () => {
    assert.equal(paneFrom({ HERDR_PANE_ID: "w1:p2" }), "w1:p2");
    assert.equal(paneFrom({}), null);
    assert.equal(paneFrom({ HERDR_PANE_ID: "bad pane;x" }), null);
  });
  it("parseJsonOutput skips leading warning text", () => {
    assert.deepEqual(parseJsonOutput('Warning: x\n{"id":"a"}'), { id: "a" });
    assert.deepEqual(parseJsonOutput('note\n[{"id":"a"}]'), [{ id: "a" }]);
  });
});

/** A registered checkout, a separate caller worktree holding images, and an empty home. */
async function fixture() {
  const tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "rr-")));
  const repo = path.join(tmp, "repo");
  const worktree = path.join(tmp, "worktree");
  const home = path.join(tmp, "home");
  await Promise.all([fs.mkdir(repo), fs.mkdir(worktree), fs.mkdir(home)]);
  await fs.writeFile(path.join(worktree, "a.png"), "A1");
  await fs.writeFile(path.join(worktree, "b.png"), "B1");
  await fs.writeFile(path.join(worktree, "notes.txt"), "T");
  return { tmp, repo, worktree, home, reviewRoot: path.join(home, ".local", "share", "breakdown", "reviews") };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr, code = 1) => ({ code, stdout: "", stderr });

function fakeFetch(projects) {
  return async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { projects } } }) });
}

/** Runs requestReview against fakes; `handlers` keys are `cmd arg0 arg1`, values a result or (args, n) => result. */
async function harness(fx, { item, children = [], handlers = {}, env = { HERDR_PANE_ID: "w1:p2" }, fetch, argv } = {}) {
  const calls = [];
  const counts = {};
  const defaults = {
    "git rev-parse --path-format=absolute": ok(`${fx.repo}/.git\n`),
    [`bd show ${ITEM}`]: ok(JSON.stringify([item ?? { id: ITEM, title: "Board header", issue_type: "task", dependencies: [] }])),
    [`bd list --parent`]: ok(JSON.stringify(children)),
    "bd create --title": ok(JSON.stringify({ id: REVIEW, title: "Review: Board header" })),
  };
  const table = { ...defaults, ...handlers };
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const key = [cmd, ...args.slice(0, 2)].join(" ");
    counts[key] = (counts[key] ?? 0) + 1;
    const handler = table[key];
    if (handler === undefined) return ok();
    return typeof handler === "function" ? handler(args, counts[key]) : handler;
  };
  const out = [];
  const warn = [];
  const result = await requestReview({
    argv: argv ?? [ITEM, "--summary", "check the header", "a.png", "b.png"],
    cwd: fx.worktree,
    env,
    homedir: fx.home,
    run,
    fetch: fetch ?? fakeFetch([{ key: "scratch", path: fx.repo }]),
    out: (l) => out.push(l),
    warn: (l) => warn.push(l),
    breakdownRoot: BREAKDOWN_ROOT,
    pid: 4242,
  });
  return { result, calls, out, warn };
}

const WRITES = new Set(["create", "update", "comments", "dep"]);
const writeCalls = (calls) => calls.filter((c) => c.cmd === "bd" && WRITES.has(c.args[0]));
const order = (calls) => calls.map((c) => [c.cmd, c.args[0]].join(" "));

async function assertNothingFiled(fx, h) {
  assert.equal(h.result.exitCode, 1);
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal(h.calls.some((c) => c.cmd === "open" || c.cmd === "herdr"), false);
  await assert.rejects(fs.access(fx.reviewRoot));
}

describe("requestReview refusals", () => {
  it("refuses an unregistered checkout", async () => {
    const fx = await fixture();
    const h = await harness(fx, { fetch: fakeFetch([{ key: "other", path: path.join(fx.tmp, "other") }]) });
    assert.deepEqual(h.warn, [
      `review-request: checkout ${fx.repo} is not registered with breakdown. Register it with: cd ${BREAKDOWN_ROOT} && pnpm ingest:beads ${fx.repo} --project <key>. Nothing was filed.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses when the server cannot be reached", async () => {
    const fx = await fixture();
    const refused = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const h = await harness(fx, { fetch: refused });
    assert.deepEqual(h.warn, [
      `review-request: cannot reach the breakdown server at http://127.0.0.1:4310/trpc/beadsProjects (ECONNREFUSED). Start it with \`pnpm dev\` in ${BREAKDOWN_ROOT}, then retry. Nothing was filed.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses a server error, using WEB_SERVER_PORT", async () => {
    const fx = await fixture();
    const h = await harness(fx, {
      env: { WEB_SERVER_PORT: "4313" },
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    assert.deepEqual(h.warn, [
      `review-request: cannot reach the breakdown server at http://127.0.0.1:4313/trpc/beadsProjects (HTTP 500). Start it with \`pnpm dev\` in ${BREAKDOWN_ROOT}, then retry. Nothing was filed.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses a missing item", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { [`bd show ${ITEM}`]: fail(`Error: no issue found matching "${ITEM}"\nmore`) } });
    assert.deepEqual(h.warn, [
      `review-request: no issue ${ITEM} in project scratch (${fx.repo}): Error: no issue found matching "${ITEM}". Nothing was filed.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses when outside a git checkout", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "git rev-parse --path-format=absolute": fail("fatal: not a git repository", 128) } });
    assert.deepEqual(h.warn, [
      `review-request: ${fx.worktree} is not inside a git checkout; run it from a registered checkout or one of its worktrees.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("names a missing image and a non-image together, before any lookup", async () => {
    const fx = await fixture();
    const h = await harness(fx, { argv: [ITEM, "--summary", "s", "a.png", "gone.png", "notes.txt"] });
    assert.deepEqual(h.warn, [
      "review-request: image not found: gone.png",
      "review-request: not an image (png, jpg, jpeg, gif, webp): notes.txt",
      "review-request: Nothing was filed.",
    ]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });

  it("exits 2 with usage on bad arguments", async () => {
    const fx = await fixture();
    const h = await harness(fx, { argv: [ITEM, "a.png"] });
    assert.equal(h.result.exitCode, 2);
    assert.deepEqual(h.warn, ["review-request: --summary is required", USAGE]);
    assert.deepEqual(h.calls, []);
  });
});

describe("requestReview writes", () => {
  it("files a first review on a task", async () => {
    const fx = await fixture();
    const h = await harness(fx);
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(order(h.calls), [
      "git rev-parse",
      "bd show",
      "bd list",
      "bd create",
      "bd update",
      "bd dep",
      "open -a",
      "herdr notification",
    ]);
    const list = h.calls.find((c) => c.args[0] === "list");
    assert.deepEqual(list.args, ["list", "--parent", ITEM, "--label", "review", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json"]);
    const create = h.calls.find((c) => c.args[0] === "create");
    assert.deepEqual(create.args, [
      "create", "--title", "Review: Board header", "--type", "task", "--labels", "review", "--no-inherit-labels",
      "--parent", ITEM, "-d", "check the header", "--acceptance", "Accepted from the breakdown board", "--json",
    ]);
    for (const call of h.calls.filter((c) => c.cmd === "bd")) assert.equal(call.cwd, fx.repo);

    const dir = path.join(fx.reviewRoot, "scratch", REVIEW);
    const update = h.calls.find((c) => c.args[0] === "update");
    assert.deepEqual(update.args.slice(0, 3), ["update", REVIEW, "--metadata"]);
    assert.equal(update.args.length, 4);
    assert.deepEqual(JSON.parse(update.args[3]), {
      review: { images: [path.join(dir, "01-a.png"), path.join(dir, "02-b.png")], pane: "w1:p2", summary: "check the header" },
    });
    assert.deepEqual((await fs.readdir(dir)).sort(), ["01-a.png", "02-b.png"]);
    assert.equal(await fs.readFile(path.join(dir, "01-a.png"), "utf8"), "A1");
    assert.deepEqual(await fs.readdir(path.join(fx.reviewRoot, "scratch")), [REVIEW]);

    assert.deepEqual(h.calls.find((c) => c.args[0] === "dep").args, ["dep", "add", ITEM, REVIEW, "--type", "blocks"]);
    const link = `http://localhost:5173/board?project=scratch&item=${REVIEW}`;
    assert.deepEqual(h.calls.find((c) => c.cmd === "open").args, ["-a", "Google Chrome", link]);
    assert.deepEqual(h.calls.find((c) => c.cmd === "herdr").args, [
      "notification", "show", `Review requested: scratch ${ITEM}`, "--body", "check the header", "--sound", "request",
    ]);
    assert.deepEqual(h.warn, []);
    assert.deepEqual(h.out, [
      `Review ${REVIEW} filed for ${ITEM} in scratch (2 images).`,
      `Board: ${link}`,
      `End your turn now and wait for a prompt in this pane with the decision (Review ${REVIEW} accepted|changes requested: …). If none arrives, read \`bd comments ${REVIEW}\`.`,
    ]);
  });

  it("does not add a blocks dependency for an epic", async () => {
    const fx = await fixture();
    const h = await harness(fx, { item: { id: ITEM, title: "Epic", issue_type: "epic", dependencies: [] } });
    assert.equal(h.result.exitCode, 0);
    assert.equal(h.calls.some((c) => c.args[0] === "dep"), false);
  });

  it("parses create output that has warning text before the JSON", async () => {
    const fx = await fixture();
    const h = await harness(fx, {
      handlers: { "bd create --title": ok(`Warning: auto-flush pending\n[{"id":"${REVIEW}"}]\n`) },
    });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(h.calls.find((c) => c.args[0] === "update").args[1], REVIEW);
  });

  it("reuses an open review on re-request", async () => {
    const fx = await fixture();
    const dir = path.join(fx.reviewRoot, "scratch", REVIEW);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "01-old.png"), "old");
    const existing = {
      id: REVIEW,
      created_at: "2026-10-28T00:00:00Z",
      labels: ["review", "review:changes"],
      metadata: { team: "x", review: { images: [path.join(dir, "01-old.png")], pane: "w0:p0", summary: "old" } },
    };
    const item = {
      id: ITEM,
      title: "Board header",
      issue_type: "task",
      dependencies: [{ id: REVIEW, dependency_type: "blocks" }],
    };
    const h = await harness(fx, { item, children: [existing], argv: [ITEM, "--summary", "second look", "b.png"] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(h.calls.some((c) => c.args[0] === "create"), false);
    assert.equal(h.calls.some((c) => c.args[0] === "dep"), false);
    const update = h.calls.find((c) => c.args[0] === "update");
    assert.deepEqual(update.args.slice(0, 3), ["update", REVIEW, "--metadata"]);
    assert.deepEqual(update.args.slice(4), ["--remove-label", "review:changes"]);
    assert.deepEqual(JSON.parse(update.args[3]), {
      team: "x",
      review: { images: [path.join(dir, "01-b.png")], pane: "w1:p2", summary: "second look" },
    });
    assert.deepEqual(h.calls.find((c) => c.args[0] === "comments").args, ["comments", "add", REVIEW, "Review updated: second look"]);
    assert.deepEqual(await fs.readdir(dir), ["01-b.png"]);
    assert.equal(h.out[0], `Review ${REVIEW} updated for ${ITEM} in scratch (1 images).`);
  });

  it("warns when several reviews are open and adds the dependency on reuse", async () => {
    const fx = await fixture();
    const children = [
      { id: "scr-1.2", created_at: "2026-10-28T02:00:00Z", labels: ["review"] },
      { id: "scr-1.1", created_at: "2026-10-28T01:00:00Z", labels: ["review"] },
    ];
    const h = await harness(fx, { children });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(h.warn, [`review-request: 2 open reviews for ${ITEM}; reusing the newest, scr-1.2.`]);
    const update = h.calls.find((c) => c.args[0] === "update");
    assert.equal(update.args.length, 4);
    assert.deepEqual(h.calls.find((c) => c.args[0] === "dep").args, ["dep", "add", ITEM, "scr-1.2", "--type", "blocks"]);
  });

  it("names the bead when a step after create fails, and a re-run reuses it", async () => {
    const fx = await fixture();
    const first = await harness(fx, { handlers: { "bd update scr-1.1": fail("Error: database is locked") } });
    assert.equal(first.result.exitCode, 1);
    assert.deepEqual(first.warn, [
      `review-request: review ${REVIEW} was filed but bd update failed: Error: database is locked. Re-run the same command to retry; it reuses ${REVIEW}.`,
    ]);
    assert.equal(first.calls.some((c) => c.cmd === "open" || c.cmd === "herdr" || c.args[0] === "dep"), false);

    const second = await harness(fx, {
      children: [{ id: REVIEW, created_at: "2026-10-28T00:00:00Z", labels: ["review"] }],
    });
    assert.equal(second.result.exitCode, 0, second.warn.join("\n"));
    assert.equal(second.calls.some((c) => c.args[0] === "create"), false);
    assert.equal(second.calls.find((c) => c.args[0] === "update").args[1], REVIEW);
  });

  it("refuses with nothing filed when bd create fails", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "bd create --title": fail("Error: parent not found") } });
    assert.deepEqual(h.warn, [`review-request: bd create failed in ${fx.repo}: Error: parent not found. Nothing was filed.`]);
    assert.equal(h.result.exitCode, 1);
    await assert.rejects(fs.access(fx.reviewRoot));
  });

  it("treats Chrome and herdr failures as warnings", async () => {
    const fx = await fixture();
    const h = await harness(fx, {
      handlers: {
        "open -a Google Chrome": fail("spawn open ENOENT", 127),
        "herdr notification show": fail("spawn herdr ENOENT", 127),
      },
    });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(h.warn, [
      `review-request: could not open Chrome (spawn open ENOENT); open http://localhost:5173/board?project=scratch&item=${REVIEW} yourself.`,
      "review-request: herdr notification failed (spawn herdr ENOENT).",
    ]);
    assert.equal(h.out.length, 3);
  });

  it("warns without HERDR_PANE_ID and leaves pane out of the metadata", async () => {
    const fx = await fixture();
    const h = await harness(fx, { env: {} });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(h.warn, [
      `review-request: HERDR_PANE_ID is not set to a pane id, so the decision cannot be pushed to this pane; read \`bd comments ${REVIEW}\` for it.`,
    ]);
    const metadata = JSON.parse(h.calls.find((c) => c.args[0] === "update").args[3]);
    assert.equal("pane" in metadata.review, false);
  });
});
