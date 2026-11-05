import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CHROME_APP_TAB_SCRIPT,
  USAGE,
  apiBase,
  boardLink,
  chooseReview,
  copiedName,
  findProject,
  paneFrom,
  socketFrom,
  parseArgs,
  parseJsonOutput,
  requestReview,
  reviewMetadata,
  splitCard,
  validateCard,
} from "./review-request-lib.mjs";

const BREAKDOWN_ROOT = "/opt/breakdown";
const ITEM = "scr-1";
const REVIEW = "scr-1.1";
const BOARD = "http://localhost:5310";
const SOCKET = "/tmp/herdr-test/herdr.sock";

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix) {
  const dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

describe("parseArgs", () => {
  it("accepts an item, a summary, and images", () => {
    assert.deepEqual(parseArgs(["scr-1", "--summary", "header", "a.png", "b.png"]), {
      args: { itemId: "scr-1", summary: "header", boardUrl: BOARD, images: ["a.png", "b.png"] },
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
  it("refuses a bad item id, one starting with -, and a missing one", () => {
    assert.match(parseArgs(["scr 1", "--summary", "s", "a.png"]).error, /not an issue id/);
    assert.match(parseArgs(["scr;rm", "--summary", "s", "a.png"]).error, /not an issue id/);
    assert.match(parseArgs(["--summary", "s", "--", "-x", "a.png"]).error, /not an issue id: -x/);
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
    assert.equal(boardLink(`${BOARD}/`, "my proj", "a&b"), `${BOARD}/board?project=my%20proj&item=a%26b`);
  });
  it("apiBase takes a numeric WEB_SERVER_PORT only", () => {
    assert.equal(apiBase({}), "http://127.0.0.1:4310");
    assert.equal(apiBase({ WEB_SERVER_PORT: "4313" }), "http://127.0.0.1:4313");
    assert.equal(apiBase({ WEB_SERVER_PORT: "4313@evil.test" }), "http://127.0.0.1:4310");
    assert.equal(apiBase({ WEB_SERVER_PORT: "" }), "http://127.0.0.1:4310");
  });
  it("findProject matches through a symlink", async () => {
    const tmp = await tempDir("rr-find-");
    const real = path.join(tmp, "real");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(tmp, "link"));
    const projects = [
      { key: "other", path: path.join(tmp, "missing") },
      { key: "scratch", path: path.join(tmp, "link") },
    ];
    assert.equal(findProject(projects, real)?.key, "scratch");
    assert.equal(findProject(projects, path.join(tmp, "elsewhere")), null);
  });
  it("chooseReview picks the newest by time, not by text, and counts", () => {
    assert.equal(chooseReview([]), null);
    const chosen = chooseReview([
      { id: "a", created_at: "2026-10-28T23:30:00-04:00" },
      { id: "b", created_at: "2026-10-29T03:00:00Z" },
      { id: "c", created_at: "not a date" },
    ]);
    assert.equal(chosen.review.id, "a");
    assert.equal(chosen.count, 3);
  });
  it("reviewMetadata holds only the review key and omits a null pane", () => {
    assert.deepEqual(reviewMetadata({ images: ["n"], pane: null, summary: "s" }), {
      review: { images: ["n"], summary: "s" },
    });
    assert.deepEqual(reviewMetadata({ images: ["n"], pane: "p1", summary: "s" }), {
      review: { images: ["n"], pane: "p1", summary: "s" },
    });
    assert.deepEqual(reviewMetadata({ images: ["n"], pane: "p1", socket: "/s.sock", summary: "s" }), {
      review: { images: ["n"], pane: "p1", socket: "/s.sock", summary: "s" },
    });
  });
  it("paneFrom accepts pane ids only", () => {
    assert.equal(paneFrom({ HERDR_PANE_ID: "w1:p2" }), "w1:p2");
    assert.equal(paneFrom({}), null);
    assert.equal(paneFrom({ HERDR_PANE_ID: "bad pane;x" }), null);
    assert.equal(paneFrom({ HERDR_PANE_ID: "-rf" }), null);
    assert.equal(paneFrom({ HERDR_PANE_ID: ":p2" }), null);
    assert.equal(paneFrom({ HERDR_PANE_ID: "w".repeat(64) }), "w".repeat(64));
    assert.equal(paneFrom({ HERDR_PANE_ID: "w".repeat(65) }), null);
  });
  it("socketFrom accepts absolute, bounded paths without control characters only", () => {
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: "/Users/x/.config/herdr/herdr.sock" }), "/Users/x/.config/herdr/herdr.sock");
    assert.equal(socketFrom({}), null);
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: "" }), null);
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: "herdr.sock" }), null);
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: "/tmp/a\nb.sock" }), null);
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: `/${"s".repeat(511)}` }), `/${"s".repeat(511)}`);
    assert.equal(socketFrom({ HERDR_SOCKET_PATH: `/${"s".repeat(512)}` }), null);
  });
  it("parseJsonOutput skips leading warning text", () => {
    assert.deepEqual(parseJsonOutput('Warning: x\n{"id":"a"}'), { id: "a" });
    assert.deepEqual(parseJsonOutput('note\n[{"id":"a"}]'), [{ id: "a" }]);
  });
});

/** A registered checkout, a separate caller worktree holding images, and an empty home. */
async function fixture() {
  const tmp = await tempDir("rr-");
  const repo = path.join(tmp, "repo");
  const worktree = path.join(tmp, "worktree");
  const home = path.join(tmp, "home");
  await Promise.all([fs.mkdir(repo), fs.mkdir(worktree), fs.mkdir(home)]);
  await fs.writeFile(path.join(worktree, "a.png"), "A1");
  await fs.writeFile(path.join(worktree, "b.png"), "B1");
  await fs.writeFile(path.join(worktree, "notes.txt"), "T");
  const reviewRoot = path.join(home, ".local", "share", "breakdown", "reviews");
  return { tmp, repo, worktree, home, reviewRoot, projectDir: path.join(reviewRoot, "scratch") };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr, code = 1) => ({ code, stdout: "", stderr });

function fakeFetch(projects) {
  return async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { projects } } }) });
}

/** Runs requestReview against fakes; `handlers` keys are `cmd arg0 arg1`, values a result or (args, n) => result. */
async function harness(fx, { item, children = [], handlers = {}, env = { HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: SOCKET }, fetch, argv, importYaml } = {}) {
  const calls = [];
  const counts = {};
  const defaults = {
    "git rev-parse --path-format=absolute": ok(`${fx.repo}/.git\n`),
    [`bd show ${ITEM}`]: ok(JSON.stringify([item ?? { id: ITEM, title: "Board header", issue_type: "task", dependencies: [] }])),
    [`bd list --parent`]: ok(JSON.stringify(children)),
    "bd create --title": ok(JSON.stringify({ id: REVIEW, title: "Review: Board header" })),
    [PROBE_KEY]: ok("none\n"),
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
    ...(importYaml === undefined ? {} : { importYaml }),
  });
  return { result, calls, out, warn };
}

const WRITES = new Set(["create", "update", "comments", "dep"]);
const writeCalls = (calls) => calls.filter((c) => c.cmd === "bd" && WRITES.has(c.args[0]));
const order = (calls) => calls.map((c) => [c.cmd, c.args[0]].join(" "));
const PROBE_KEY = `osascript -e ${CHROME_APP_TAB_SCRIPT}`;
const callTo = (h, sub) => h.calls.find((c) => c.cmd === "bd" && c.args[0] === sub);

/** Every entry under the review root except the bare project directory staging may create. */
async function reviewEntries(fx) {
  try {
    return (await fs.readdir(fx.reviewRoot, { recursive: true })).filter((e) => e !== "scratch");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function assertNothingFiled(fx, h) {
  assert.equal(h.result.exitCode, 1);
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal(h.calls.some((c) => c.cmd === "osascript" || c.cmd === "open" || c.cmd === "herdr"), false);
  assert.deepEqual(await reviewEntries(fx), []);
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

  it("refuses when bd list fails", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "bd list --parent": fail("Error: database locked") } });
    assert.deepEqual(h.warn, [
      `review-request: cannot list open reviews of ${ITEM} in scratch: Error: database locked. Nothing was filed.`,
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses when bd list does not print an array", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "bd list --parent": ok('{"id":"x"}') } });
    assert.deepEqual(h.warn, [
      `review-request: cannot list open reviews of ${ITEM} in scratch: unreadable output from bd list. Nothing was filed.`,
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

  it("refuses with nothing filed when an image vanishes before it is copied", async () => {
    const fx = await fixture();
    const vanish = async () => {
      await fs.rm(path.join(fx.worktree, "b.png"));
      return ok(`${fx.repo}/.git\n`);
    };
    const h = await harness(fx, { handlers: { "git rev-parse --path-format=absolute": vanish } });
    assert.equal(h.warn.length, 1);
    assert.match(h.warn[0], new RegExp(`^review-request: could not copy the images under ${fx.projectDir}: ENOENT.*b\\.png.*\\. Nothing was filed\\.$`));
    await assertNothingFiled(fx, h);
  });

  it("refuses with nothing filed when bd create fails", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "bd create --title": fail("Error: parent not found") } });
    assert.deepEqual(h.warn, [`review-request: bd create failed in ${fx.repo}: Error: parent not found. Nothing was filed.`]);
    assert.equal(h.result.exitCode, 1);
    assert.deepEqual(await reviewEntries(fx), []);
  });

  it("refuses when bd create exits 0 without an id", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { "bd create --title": ok("Created.\n") } });
    assert.deepEqual(h.warn, [
      `review-request: bd create ran but printed no issue id; check \`bd list --parent ${ITEM} --label review\` in ${fx.repo} before retrying.`,
    ]);
    assert.equal(h.result.exitCode, 1);
    assert.equal(h.calls.some((c) => c.args[0] === "update" || c.cmd === "open"), false);
    assert.deepEqual(await reviewEntries(fx), []);
  });

  it("reports an unexpected error as one line", async () => {
    const fx = await fixture();
    const boom = () => {
      throw new Error("boom");
    };
    const h = await harness(fx, { handlers: { [`bd show ${ITEM}`]: boom } });
    assert.deepEqual(h.warn, ["review-request: unexpected error: boom"]);
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
      "osascript -e",
      "open -a",
      "herdr notification",
    ]);
    assert.deepEqual(callTo(h, "list").args, [
      "list", "--parent", ITEM, "--label", "review", "--status", "open,in_progress,blocked,deferred", "--limit", "0", "--json",
    ]);
    assert.deepEqual(callTo(h, "create").args, [
      "create", "--title", "Review: Board header", "--type", "task", "--labels", "review", "--no-inherit-labels",
      "--parent", ITEM, "-d", "check the header", "--acceptance", "Accepted from the breakdown board", "--json",
    ]);
    for (const call of h.calls.filter((c) => c.cmd === "bd")) assert.equal(call.cwd, fx.repo);

    const dir = path.join(fx.projectDir, REVIEW);
    const update = callTo(h, "update");
    assert.deepEqual(update.args.slice(0, 3), ["update", REVIEW, "--metadata"]);
    assert.equal(update.args.length, 4);
    assert.deepEqual(JSON.parse(update.args[3]), {
      review: { images: [path.join(dir, "01-a.png"), path.join(dir, "02-b.png")], pane: "w1:p2", socket: SOCKET, summary: "check the header" },
    });
    assert.deepEqual((await fs.readdir(dir)).sort(), ["01-a.png", "02-b.png"]);
    assert.equal(await fs.readFile(path.join(dir, "01-a.png"), "utf8"), "A1");
    assert.deepEqual(await fs.readdir(fx.projectDir), [REVIEW]);

    assert.deepEqual(callTo(h, "dep").args, ["dep", "add", ITEM, REVIEW, "--type", "blocks"]);
    const link = `${BOARD}/board?project=scratch&item=${REVIEW}`;
    assert.deepEqual(h.calls.find((c) => c.cmd === "osascript").args, ["-e", CHROME_APP_TAB_SCRIPT, `${BOARD}/`]);
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
    assert.equal(callTo(h, "update").args[1], REVIEW);
  });

  it("reuses an open review on re-request", async () => {
    const fx = await fixture();
    const dir = path.join(fx.projectDir, REVIEW);
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
    const update = callTo(h, "update");
    assert.deepEqual(update.args.slice(0, 3), ["update", REVIEW, "--metadata"]);
    assert.deepEqual(update.args.slice(4), ["--description", "second look", "--remove-label", "review:changes"]);
    assert.deepEqual(JSON.parse(update.args[3]), {
      review: { images: [path.join(dir, "01-b.png")], pane: "w1:p2", socket: SOCKET, summary: "second look" },
    });
    assert.deepEqual(callTo(h, "comments").args, ["comments", "add", REVIEW, "Review updated: second look"]);
    assert.deepEqual(await fs.readdir(dir), ["01-b.png"]);
    assert.deepEqual(await fs.readdir(fx.projectDir), [REVIEW]);
    assert.equal(h.out[0], `Review ${REVIEW} updated for ${ITEM} in scratch (1 image).`);
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
    assert.deepEqual(callTo(h, "update").args.slice(4), ["--description", "check the header"]);
    assert.deepEqual(callTo(h, "dep").args, ["dep", "add", ITEM, "scr-1.2", "--type", "blocks"]);
  });

  it("names the bead when a step after create fails, and a re-run reuses it without an update comment", async () => {
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
    assert.equal(callTo(second, "update").args[1], REVIEW);
    assert.equal(callTo(second, "comments"), undefined);
    assert.deepEqual(await fs.readdir(fx.projectDir), [REVIEW]);
  });

  it("names the bead when bd dep add fails", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { [`bd dep add`]: fail("Error: cycle") } });
    assert.equal(h.result.exitCode, 1);
    assert.deepEqual(h.warn, [
      `review-request: review ${REVIEW} was filed but bd dep add failed: Error: cycle. Re-run the same command to retry; it reuses ${REVIEW}.`,
    ]);
    assert.equal(h.calls.some((c) => c.cmd === "open" || c.cmd === "herdr"), false);
  });

  it("leaves an open app tab alone and still notifies", async () => {
    const fx = await fixture();
    const h = await harness(fx, {
      argv: [ITEM, "--summary", "check the header", "--board-url", `${BOARD}//`, "a.png"],
      handlers: { [PROBE_KEY]: ok("present\n") },
    });
    assert.equal(h.result.exitCode, 0);
    const link = `${BOARD}/board?project=scratch&item=${REVIEW}`;
    assert.deepEqual(h.calls.find((c) => c.cmd === "osascript").args, ["-e", CHROME_APP_TAB_SCRIPT, `${BOARD}/`]);
    assert.equal(h.calls.some((c) => c.cmd === "open"), false);
    assert.deepEqual(order(h.calls).slice(-2), ["osascript -e", "herdr notification"]);
    assert.deepEqual(h.warn, []);
    assert.deepEqual(h.out, [
      `Review ${REVIEW} filed for ${ITEM} in scratch (1 image).`,
      `Board: ${link}`,
      "Review queued in the open breakdown tab.",
      `End your turn now and wait for a prompt in this pane with the decision (Review ${REVIEW} accepted|changes requested: …). If none arrives, read \`bd comments ${REVIEW}\`.`,
    ]);
  });

  it("opens the board link when no app tab is open or Chrome is not running", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { [PROBE_KEY]: ok("none\n") } });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(order(h.calls).slice(-3), ["osascript -e", "open -a", "herdr notification"]);
    assert.deepEqual(h.calls.find((c) => c.cmd === "open").args, [
      "-a", "Google Chrome", `${BOARD}/board?project=scratch&item=${REVIEW}`,
    ]);
    assert.deepEqual(h.warn, []);
    assert.equal(h.out.includes("Review queued in the open breakdown tab."), false);
  });

  it("warns and opens a new tab when osascript fails", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { [PROBE_KEY]: fail("execution error: Not authorized to send Apple events to Google Chrome. (-1743)") } });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(order(h.calls).slice(-3), ["osascript -e", "open -a", "herdr notification"]);
    assert.deepEqual(h.warn, [
      "review-request: could not tell whether an app tab is open (execution error: Not authorized to send Apple events to Google Chrome. (-1743)); opening a new one.",
    ]);
    assert.equal(h.out.length, 3);
  });

  it("warns and opens a new tab when osascript prints something unexpected", async () => {
    const fx = await fixture();
    const h = await harness(fx, { handlers: { [PROBE_KEY]: ok("reused\n") } });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(order(h.calls).slice(-3), ["osascript -e", "open -a", "herdr notification"]);
    assert.deepEqual(h.warn, [
      'review-request: could not tell whether an app tab is open (unexpected output "reused"); opening a new one.',
    ]);
  });

  it("probes with a trailing-slash prefix so :5310 never matches :53100", async () => {
    const fx = await fixture();
    for (const boardUrl of [BOARD, `${BOARD}/`, `${BOARD}///`]) {
      const h = await harness(fx, { argv: [ITEM, "--summary", "s", "--board-url", boardUrl, "a.png"] });
      assert.deepEqual(h.calls.find((c) => c.cmd === "osascript").args.slice(2), [`${BOARD}/`]);
    }
  });

  it("the tab probe never launches, navigates, or raises Chrome", () => {
    for (const forbidden of ["set URL", "activate", "set index", "active tab index", "make new", "open location", "reload", "close"]) {
      assert.equal(CHROME_APP_TAB_SCRIPT.includes(forbidden), false, forbidden);
    }
    const guard = CHROME_APP_TAB_SCRIPT.indexOf('if application "Google Chrome" is not running then return "none"');
    assert.ok(guard !== -1 && guard < CHROME_APP_TAB_SCRIPT.indexOf('tell application "Google Chrome"'));
    assert.match(CHROME_APP_TAB_SCRIPT, /starts with appPrefix then return "present"/);
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
      `review-request: could not open Chrome (spawn open ENOENT); open ${BOARD}/board?project=scratch&item=${REVIEW} yourself.`,
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
    const metadata = JSON.parse(callTo(h, "update").args[3]);
    assert.equal("pane" in metadata.review, false);
  });

  it("warns when HERDR_SOCKET_PATH is missing or not absolute and leaves socket out of the metadata", async () => {
    for (const env of [{ HERDR_PANE_ID: "w1:p2" }, { HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "rel/herdr.sock" }]) {
      const fx = await fixture();
      const h = await harness(fx, { env });
      assert.equal(h.result.exitCode, 0);
      assert.deepEqual(h.warn, [
        `review-request: HERDR_SOCKET_PATH is not set to an absolute socket path, so the decision cannot be pushed to this pane; read \`bd comments ${REVIEW}\` for it.`,
      ]);
      const metadata = JSON.parse(callTo(h, "update").args[3]);
      assert.equal(metadata.review.pane, "w1:p2");
      assert.equal("socket" in metadata.review, false);
    }
  });
});

// ---- Card form (decision-card-reviews, design.md decision 4) ----

const CARDS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "review-cards");
const CARD_ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr-test.sock" };
const PLACEHOLDER_ROOT = "/REVIEW_ROOT/PROJECT/BEAD";
const FILED_ORDER = ["git rev-parse", "bd show", "bd list", "bd create", "bd update", "bd dep", "osascript -e", "open -a", "herdr notification"];
const cardFixtures = await fs.readdir(CARDS);
const VALID_CARDS = cardFixtures.filter((n) => n.endsWith(".expected.json")).map((n) => n.slice(0, -".expected.json".length)).sort();
const INVALID_CARDS = cardFixtures.filter((n) => n.startsWith("invalid-") && n.endsWith(".md")).sort();
/** The refusal each invalid fixture gets; a fixture missing here is still checked for refusing with nothing filed. */
const INVALID_REFUSALS = {
  "invalid-question-too-long.md": ["question: at most 140 characters, got 160", "Nothing was filed."],
  "invalid-repeated-option-id.md": ["options[1].id: A repeats options[0].id", "Nothing was filed."],
  "invalid-recommend-unknown.md": ['recommend: "D" names no option (options: A, B, C)', "Nothing was filed."],
  "invalid-unknown-kind.md": ['attachments[0].kind: must be image, mermaid, or diff, got "video"', "Nothing was filed."],
  "invalid-unknown-key.md": ["recomend: unknown field (card fields: question, options, recommend, on_accept, attachments)", "Nothing was filed."],
  "invalid-missing-frontmatter.md": [
    `frontmatter: missing in ${path.join(CARDS, "invalid-missing-frontmatter.md")}; a card starts with a \`---\` line, the card's YAML, and another \`---\` line. Nothing was filed.`,
  ],
};

/** Writes a card under the caller worktree's `cards/` and returns its cwd-relative path. */
async function writeCard(fx, text, name = "card.md") {
  await fs.mkdir(path.join(fx.worktree, "cards"), { recursive: true });
  await fs.writeFile(path.join(fx.worktree, "cards", name), text);
  return path.join("cards", name);
}

const QUESTION_ONLY = "---\nquestion: Ship it?\n---\n";

describe("parseArgs card form", () => {
  it("takes one .md positional without --summary as a card", () => {
    assert.deepEqual(parseArgs(["scr-1", "cards/x.md"]), { args: { itemId: "scr-1", cardPath: "cards/x.md", boardUrl: BOARD } });
    assert.deepEqual(parseArgs(["scr-1", "x.md", "--board-url", "https://board.test"]), {
      args: { itemId: "scr-1", cardPath: "x.md", boardUrl: "https://board.test" },
    });
    assert.match(parseArgs(["scr-1", "x.md", "--board-url", "file:///x"]).error, /http\(s\) URL/);
  });
  it("leaves every other shape to the image form", () => {
    assert.deepEqual(parseArgs(["scr-1", "--summary", "s", "x.md"]), {
      args: { itemId: "scr-1", summary: "s", boardUrl: BOARD, images: ["x.md"] },
    });
    assert.match(parseArgs(["scr-1", "x.md", "a.png"]).error, /--summary is required/);
    assert.match(parseArgs(["scr-1", "x.md", "y.md"]).error, /--summary is required/);
    assert.match(parseArgs(["scr-1", "x.markdown"]).error, /--summary is required/);
  });
  it("usage shows both forms", () => {
    assert.match(USAGE, /review-request <item-id> <card\.md>/);
    assert.match(USAGE, /review-request <item-id> --summary <text>/);
  });
});

describe("splitCard", () => {
  it("ends the frontmatter at the first unindented --- line and trims the body", () => {
    assert.deepEqual(splitCard("---\na: |-\n  --- a/x\n  +++ b/x\n---\n\nbody\n\n"), { frontmatter: "a: |-\n  --- a/x\n  +++ b/x", body: "body" });
    assert.deepEqual(splitCard("﻿---\r\na: 1\r\n---\r\nbody\r\n"), { frontmatter: "a: 1", body: "body" });
    assert.deepEqual(splitCard("---\na: 1\n---"), { frontmatter: "a: 1", body: "" });
  });
  it("is null without a leading or a closing fence", () => {
    assert.equal(splitCard("a: 1\n---\nbody"), null);
    assert.equal(splitCard("---\na: 1\nbody"), null);
    assert.equal(splitCard(""), null);
  });
});

describe("card fixtures", () => {
  for (const name of VALID_CARDS) {
    it(`${name}.md writes exactly ${name}.expected.json`, async () => {
      const fx = await fixture();
      const cardFile = path.join(CARDS, `${name}.md`);
      const h = await harness(fx, { argv: [ITEM, cardFile], env: CARD_ENV });
      assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
      assert.deepEqual(h.warn, []);
      assert.deepEqual(order(h.calls), FILED_ORDER);

      const dir = path.join(fx.projectDir, REVIEW);
      const expectedText = (await fs.readFile(path.join(CARDS, `${name}.expected.json`), "utf8")).replaceAll(PLACEHOLDER_ROOT, dir);
      const update = callTo(h, "update");
      assert.deepEqual(update.args.slice(0, 3), ["update", REVIEW, "--metadata"]);
      assert.equal(update.args.length, 4);
      const written = JSON.parse(update.args[3]);
      assert.deepEqual(Object.keys(written), ["review"]);
      // Serialized equality: same keys, same values, same key order.
      assert.equal(JSON.stringify(written.review), JSON.stringify(JSON.parse(expectedText)));

      const { body } = splitCard(await fs.readFile(cardFile, "utf8"));
      const create = callTo(h, "create").args;
      assert.equal(create[create.indexOf("-d") + 1], body === "" ? written.review.question : body);
      const { question, images } = written.review;
      assert.deepEqual(h.calls.find((c) => c.cmd === "herdr").args, [
        "notification", "show", `Review requested: scratch ${ITEM}`, "--body", question.slice(0, 200), "--sound", "request",
      ]);
      assert.deepEqual((await fs.readdir(dir)).sort(), images.map((p) => path.basename(p)).sort());
      for (const stored of images) {
        const source = path.join(CARDS, path.basename(stored).replace(/^\d\d-/, ""));
        assert.deepEqual(await fs.readFile(stored), await fs.readFile(source));
      }
      assert.equal(h.out[0], `Review ${REVIEW} filed for ${ITEM} in scratch (${images.length} image${images.length === 1 ? "" : "s"}).`);
    });
  }

  for (const name of INVALID_CARDS) {
    it(`${name} refuses naming its field, with nothing filed`, async () => {
      const fx = await fixture();
      const h = await harness(fx, { argv: [ITEM, path.join(CARDS, name)], env: CARD_ENV });
      const expected = INVALID_REFUSALS[name];
      if (expected) assert.deepEqual(h.warn, expected.map((line) => `review-request: ${line}`));
      else assert.match(h.warn.at(-1), /Nothing was filed\.$/);
      assert.deepEqual(h.calls, []);
      await assertNothingFiled(fx, h);
    });
  }
});

describe("card form", () => {
  it("files a card with no images and an empty body, the question as description", async () => {
    const fx = await fixture();
    const card = await writeCard(
      fx,
      '---\nquestion: "  Ship it?  "\noptions:\n  - { id: yes, label: Ship }\n  - { id: no, label: Hold, risk: "" }\nrecommend: yes\n---\n\n',
    );
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(order(h.calls), FILED_ORDER);
    const create = callTo(h, "create").args;
    assert.equal(create[create.indexOf("-d") + 1], "Ship it?");
    assert.deepEqual(JSON.parse(callTo(h, "update").args[3]), {
      review: {
        images: [],
        pane: "w1:p2",
        socket: SOCKET,
        summary: "Ship it?",
        question: "Ship it?",
        options: [{ id: "yes", label: "Ship" }, { id: "no", label: "Hold" }],
        recommend: "yes",
      },
    });
    assert.deepEqual(h.calls.find((c) => c.cmd === "herdr").args.slice(3, 5), ["--body", "Ship it?"]);
    assert.deepEqual(await fs.readdir(path.join(fx.projectDir, REVIEW)), []);
    assert.equal(h.out[0], `Review ${REVIEW} filed for ${ITEM} in scratch (0 images).`);
  });

  it("resolves image attachments against the card's directory, not the cwd", async () => {
    const fx = await fixture();
    const card = await writeCard(fx, "---\nquestion: Which header?\nattachments:\n  - kind: image\n    path: a.png\n---\nLook.\n");
    await fs.writeFile(path.join(fx.worktree, "cards", "a.png"), "CARD");
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    const stored = path.join(fx.projectDir, REVIEW, "01-a.png");
    const { review } = JSON.parse(callTo(h, "update").args[3]);
    assert.deepEqual(review.images, [stored]);
    assert.deepEqual(review.attachments, [{ kind: "image", path: stored }]);
    assert.equal(await fs.readFile(stored, "utf8"), "CARD");
  });

  it("reuses an open review on re-request, like the image form", async () => {
    const fx = await fixture();
    const existing = {
      id: REVIEW,
      created_at: "2026-10-28T00:00:00Z",
      labels: ["review", "review:changes"],
      metadata: { review: { images: [], pane: "w0:p0", summary: "Ship it?", question: "Ship it?" } },
    };
    const item = { id: ITEM, title: "Board header", issue_type: "task", dependencies: [{ id: REVIEW, dependency_type: "blocks" }] };
    const card = await writeCard(fx, `${QUESTION_ONLY}Evidence, second pass.\n`);
    const h = await harness(fx, { item, children: [existing], argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(h.calls.some((c) => c.args[0] === "create" || c.args[0] === "dep"), false);
    const update = callTo(h, "update");
    assert.deepEqual(update.args.slice(4), ["--description", "Evidence, second pass.", "--remove-label", "review:changes"]);
    assert.deepEqual(JSON.parse(update.args[3]), {
      review: { images: [], pane: "w1:p2", socket: SOCKET, summary: "Ship it?", question: "Ship it?" },
    });
    assert.deepEqual(callTo(h, "comments").args, ["comments", "add", REVIEW, "Review updated: Ship it?"]);
    assert.equal(h.out[0], `Review ${REVIEW} updated for ${ITEM} in scratch (0 images).`);
  });

  it("does not comment when reusing a review whose first request never finished", async () => {
    const fx = await fixture();
    const card = await writeCard(fx, QUESTION_ONLY);
    const h = await harness(fx, { children: [{ id: REVIEW, created_at: "2026-10-28T00:00:00Z", labels: ["review"] }], argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "comments"), undefined);
  });

  const LONG = "x".repeat(8001);
  const refusals = [
    ["a missing question", "---\noptions:\n  - { id: A, label: a }\n  - { id: B, label: b }\n---\n", ["question: required"]],
    ["a blank question", '---\nquestion: "   "\n---\n', ["question: required, got blank text"]],
    ["a non-text question", "---\nquestion: [a]\n---\n", ["question: must be text, got a list"]],
    ["options: []", "---\nquestion: Q?\noptions: []\n---\n", ["options: 2 to 6 options, got 0"]],
    ["seven options", `---\nquestion: Q?\noptions:\n${"ABCDEFG".split("").map((id) => `  - { id: ${id}, label: x }\n`).join("")}---\n`, ["options: 2 to 6 options, got 7"]],
    ["a blank label", '---\nquestion: Q?\noptions:\n  - { id: A, label: a }\n  - { id: B, label: "  " }\n---\n', ["options[1].label: required, got blank text"]],
    ["an over-long label", `---\nquestion: Q?\noptions:\n  - { id: A, label: a }\n  - { id: B, label: ${"l".repeat(81)} }\n---\n`, ["options[1].label: at most 80 characters, got 81"]],
    ["an over-long risk", `---\nquestion: Q?\noptions:\n  - { id: A, label: a, risk: ${"r".repeat(301)} }\n  - { id: B, label: b }\n---\n`, ["options[0].risk: at most 300 characters, got 301"]],
    ["a numeric option id", "---\nquestion: Q?\noptions:\n  - { id: 1, label: a }\n  - { id: B, label: b }\n---\n", ['options[0].id: got the number 1; quote it: id: "1"']],
    ["an unknown option key", "---\nquestion: Q?\noptions:\n  - { id: A, label: a, rsik: x }\n  - { id: B, label: b }\n---\n", ["options[0].rsik: not a field of an option (fields: id, label, what, risk)"]],
    ['recommend: ""', '---\nquestion: Q?\noptions:\n  - { id: A, label: a }\n  - { id: B, label: b }\nrecommend: ""\n---\n', ['recommend: "" names no option (options: A, B)']],
    ["recommend without options", "---\nquestion: Q?\nrecommend: A\n---\n", ["recommend: allowed only with options"]],
    ["a blank on_accept step", '---\nquestion: Q?\non_accept:\n  - "do it"\n  - "  "\n---\n', ["on_accept[1]: required, got blank text"]],
    ["nine on_accept steps", `---\nquestion: Q?\non_accept:\n${"  - s\n".repeat(9)}---\n`, ["on_accept: at most 8 steps, got 9"]],
    ["a bad pair", "---\nquestion: Q?\nattachments:\n  - { kind: diff, source: x, pair: left }\n---\n", ['attachments[0].pair: must be before or after, got "left"']],
    ["a source on an image", "---\nquestion: Q?\nattachments:\n  - { kind: image, path: ../a.png, source: x }\n---\n", ["attachments[0].source: not a field of an image attachment (fields: kind, path, caption, pair)"]],
    ["a mermaid without source", "---\nquestion: Q?\nattachments:\n  - { kind: mermaid }\n---\n", ["attachments[0].source: required text, got nothing"]],
    ["an over-long source", `---\nquestion: Q?\nattachments:\n  - { kind: diff, source: ${"d".repeat(8001)} }\n---\n`, ["attachments[0].source: at most 8000 characters, got 8001"]],
    [
      "a missing image and a non-image, together",
      "---\nquestion: Q?\nattachments:\n  - { kind: image, path: gone.png }\n  - { kind: image, path: ../notes.txt }\n---\n",
      ["attachments[0].path: image not found: gone.png", "attachments[1].path: not an image (png, jpg, jpeg, gif, webp): ../notes.txt"],
    ],
    ["an over-long body", `${QUESTION_ONLY}${LONG}\n`, ["body: at most 8000 characters, got 8001"]],
    ["frontmatter that is a list", "---\n- a\n---\n", ["frontmatter: must be a mapping of card fields, got a list"]],
    ["a numeric recommend", '---\nquestion: Q?\noptions:\n  - { id: "1", label: a }\n  - { id: "2", label: b }\nrecommend: 1\n---\n', ['recommend: got the number 1; quote it: recommend: "1"']],
    ["a NUL in the body", `${QUESTION_ONLY}before\u0000after\n`, ["body: contains a NUL character"]],
    ["an unpaired surrogate in the question", '---\nquestion: "Ship \\uD800 it?"\n---\n', ["question: contains an unpaired surrogate (not valid Unicode)"]],
    ["an unpaired surrogate in a source", '---\nquestion: Q?\nattachments:\n  - { kind: diff, source: "+\\uDC00" }\n---\n', ["attachments[0].source: contains an unpaired surrogate (not valid Unicode)"]],
    ["an unpaired surrogate in a step", '---\nquestion: Q?\non_accept: ["\\uD83D"]\n---\n', ["on_accept[0]: contains an unpaired surrogate (not valid Unicode)"]],
    ["a question over two lines", '---\nquestion: "Ship it,\\nor hold?"\n---\n', ["question: must be one line"]],
    ["a block-scalar question", "---\nquestion: |\n  Ship it,\n  or hold?\n---\n", ["question: must be one line"]],
    [
      "a long echoed value, cut",
      `---\nquestion: Q?\nattachments:\n  - { kind: diff, source: x, pair: ${"p".repeat(100)} }\n---\n`,
      [`attachments[0].pair: must be before or after, got "${"p".repeat(58)}…`],
    ],
  ];
  for (const [what, text, problems] of refusals) {
    it(`refuses ${what}, naming the field, before any lookup`, async () => {
      const fx = await fixture();
      const h = await harness(fx, { argv: [ITEM, await writeCard(fx, text)] });
      assert.deepEqual(h.warn, [...problems, "Nothing was filed."].map((line) => `review-request: ${line}`));
      assert.deepEqual(h.calls, []);
      await assertNothingFiled(fx, h);
    });
  }

  it("refuses frontmatter that is not valid YAML", async () => {
    const fx = await fixture();
    for (const text of ["---\nquestion: a\nquestion: b\n---\n", "\uFEFF---\r\nquestion: a\r\nquestion: b\r\n---\r\n"]) {
      const h = await harness(fx, { argv: [ITEM, await writeCard(fx, text)] });
      assert.deepEqual(h.warn, [
        "review-request: frontmatter: not valid YAML: Map keys must be unique at line 3, column 1 of cards/card.md. Nothing was filed.",
      ]);
      assert.deepEqual(h.calls, []);
      await assertNothingFiled(fx, h);
    }
  });

  it("refuses a card that is not a regular file, or is over 64 KB, before reading it", async () => {
    const fx = await fixture();
    await fs.mkdir(path.join(fx.worktree, "dir.md"));
    const dir = await harness(fx, { argv: [ITEM, "dir.md"] });
    assert.deepEqual(dir.warn, ["review-request: card dir.md: not a regular file. Nothing was filed."]);
    await assertNothingFiled(fx, dir);
    const big = await writeCard(fx, `${QUESTION_ONLY}${"x".repeat(64 * 1024)}`, "big.md");
    const size = (await fs.stat(path.join(fx.worktree, big))).size;
    const h = await harness(fx, { argv: [ITEM, big] });
    assert.deepEqual(h.warn, [`review-request: card ${big}: ${size} bytes, over the 65536-byte limit. Nothing was filed.`]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });

  it("names the type of a non-plain value rather than echoing it", async () => {
    const { problems } = await validateCard({ question: new Date(0), on_accept: [new Map()] }, "", "/");
    assert.deepEqual(problems, ["question: must be text, got a Date", "on_accept[0]: must be text, got a Map"]);
  });

  it("refuses an unpaired surrogate in the body", async () => {
    const { problems } = await validateCard({ question: "Q?" }, "a\uD800b", "/");
    assert.deepEqual(problems, ["body: contains an unpaired surrogate (not valid Unicode)"]);
  });

  it("files a CRLF card with a BOM exactly as its LF twin", async () => {
    const lf = '---\nquestion: Ship it?\noptions:\n  - id: A\n    label: Ship\n  - id: B\n    label: Hold\non_accept:\n  - |-\n    two\n    lines\n---\n\nFirst line.\n\nSecond.\n';
    const written = [];
    for (const text of [lf, `\uFEFF${lf.replaceAll("\n", "\r\n")}`]) {
      const fx = await fixture();
      const h = await harness(fx, { argv: [ITEM, await writeCard(fx, text)] });
      assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
      const create = callTo(h, "create").args;
      written.push({ description: create[create.indexOf("-d") + 1], metadata: callTo(h, "update").args[3] });
    }
    assert.equal(written[0].description, "First line.\n\nSecond.");
    assert.deepEqual(JSON.parse(written[0].metadata).review.on_accept, ["two\nlines"]);
    assert.deepEqual(written[1], written[0]);
  });

  it("keeps a --- rule in the body as part of the evidence", async () => {
    const fx = await fixture();
    const body = "Before the rule.\n\n---\n\nAfter the rule.";
    const h = await harness(fx, { argv: [ITEM, await writeCard(fx, `${QUESTION_ONLY}${body}\n`)] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    const create = callTo(h, "create").args;
    assert.equal(create[create.indexOf("-d") + 1], body);
    assert.deepEqual(Object.keys(JSON.parse(callTo(h, "update").args[3]).review), ["images", "pane", "socket", "summary", "question"]);
  });

  it("refuses a card file that does not exist", async () => {
    const fx = await fixture();
    const h = await harness(fx, { argv: [ITEM, "cards/gone.md"] });
    assert.deepEqual(h.warn, ["review-request: card cards/gone.md: not found. Nothing was filed."]);
    await assertNothingFiled(fx, h);
  });

  it("refuses with the remedy when the yaml package cannot load", async () => {
    const fx = await fixture();
    const missing = async () => {
      throw Object.assign(new Error("Cannot find package 'yaml' imported from /x/bin/review-request-lib.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
    };
    const h = await harness(fx, { argv: [ITEM, await writeCard(fx, QUESTION_ONLY)], importYaml: missing });
    assert.deepEqual(h.warn, [
      `review-request: the card form needs the yaml package, which did not load (Cannot find package 'yaml' imported from /x/bin/review-request-lib.mjs): run pnpm install in ${BREAKDOWN_ROOT}. Nothing was filed.`,
    ]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });

  /** A card of two diff attachments, the second `second` characters long, so its review JSON grows one for one with it. */
  const sizedCard = (second) =>
    `---\nquestion: Q?\nattachments:\n  - kind: diff\n    source: ${"a".repeat(8000)}\n  - kind: diff\n    source: ${"b".repeat(second)}\n---\n`;

  it("refuses a review over the board's 16,000-character cap, and files one exactly at it", async () => {
    const probeFx = await fixture();
    const probe = await harness(probeFx, { argv: [ITEM, await writeCard(probeFx, sizedCard(8000))] });
    const size = Number(/would be (\d+) characters/.exec(probe.warn[0])?.[1]);
    assert.ok(size > 16_000, probe.warn.join("\n"));
    const atCap = 8000 - (size - 16_000);

    const overFx = await fixture();
    const over = await harness(overFx, { argv: [ITEM, await writeCard(overFx, sizedCard(atCap + 1))] });
    assert.deepEqual(over.warn, [
      "review-request: card: the review would be 16001 characters of JSON, over the board's limit of 16000; shorten attachment sources or move that evidence into the body. Nothing was filed.",
    ]);
    assert.deepEqual(order(over.calls), ["git rev-parse", "bd show", "bd list"]);
    await assertNothingFiled(overFx, over);

    const capFx = await fixture();
    const cap = await harness(capFx, { argv: [ITEM, await writeCard(capFx, sizedCard(atCap))] });
    assert.equal(cap.result.exitCode, 0, cap.warn.join("\n"));
    assert.equal(JSON.parse(callTo(cap, "update").args[3]).review.attachments[1].source.length, atCap);
    assert.equal(callTo(cap, "update").args[3].length, `{"review":}`.length + 16_000);
  });

  it("sizes a reused review with its real id, not the new-review allowance", async () => {
    // One image: its stored path appears twice (images, attachments), so the
    // allowance for a new id (`.` + 15 digits) costs 2 × 14 more than `scr-1.1`.
    const imageCard = (second) => `${sizedCard(second).slice(0, -4)}  - kind: image\n    path: ../a.png\n---\n`;
    const probeFx = await fixture();
    const probe = await harness(probeFx, { argv: [ITEM, await writeCard(probeFx, imageCard(8000))] });
    const size = Number(/would be (\d+) characters/.exec(probe.warn[0])?.[1]);
    assert.ok(size > 16_000, probe.warn.join("\n"));
    const second = 8000 - (size - 16_010);

    const newFx = await fixture();
    const asNew = await harness(newFx, { argv: [ITEM, await writeCard(newFx, imageCard(second))] });
    assert.match(asNew.warn[0], /would be 16010 characters/);
    await assertNothingFiled(newFx, asNew);

    const reuseFx = await fixture();
    const existing = { id: REVIEW, created_at: "2026-10-28T00:00:00Z", labels: ["review"] };
    const reused = await harness(reuseFx, { children: [existing], argv: [ITEM, await writeCard(reuseFx, imageCard(second))] });
    assert.equal(reused.result.exitCode, 0, reused.warn.join("\n"));
    assert.equal(callTo(reused, "update").args[3].length, `{"review":}`.length + 16_010 - 28);
  });
});

describe("the image form never loads yaml", () => {
  it("never calls the yaml importer, filing or refusing", async () => {
    let imports = 0;
    const importYaml = async () => {
      imports += 1;
      return import("yaml");
    };
    const fx = await fixture();
    const filed = await harness(fx, { importYaml });
    assert.equal(filed.result.exitCode, 0, filed.warn.join("\n"));
    const refused = await harness(fx, { importYaml, argv: [ITEM, "--summary", "s", "gone.png"] });
    assert.equal(refused.result.exitCode, 1);
    await fs.writeFile(path.join(fx.worktree, "card.md"), QUESTION_ONLY);
    const asImage = await harness(fx, { importYaml, argv: [ITEM, "--summary", "s", "card.md"] });
    assert.deepEqual(asImage.warn.slice(0, 1), ["review-request: not an image (png, jpg, jpeg, gif, webp): card.md"]);
    assert.equal(imports, 0);
  });

  // A fresh process with a resolve hook, so whatever the real default importer does is observed, not a stub.
  const CHILD = `
import { registerHooks } from "node:module";
const cfg = JSON.parse(process.env.RR_CHILD);
const resolved = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "yaml" || specifier.startsWith("yaml/")) resolved.push(specifier);
    return next(specifier, context);
  },
});
const { requestReview } = await import(cfg.lib);
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const run = async (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  if (key.startsWith("git rev-parse")) return ok(cfg.repo + "/.git\\n");
  if (key.startsWith("bd show")) return ok(JSON.stringify([{ id: "scr-1", title: "T", issue_type: "task", dependencies: [] }]));
  if (key.startsWith("bd list")) return ok("[]");
  if (key.startsWith("bd create")) return ok(JSON.stringify({ id: "scr-1.1" }));
  if (cmd === "osascript") return ok("none\\n");
  return ok();
};
const warn = [];
const { exitCode } = await requestReview({
  argv: cfg.argv, cwd: cfg.cwd, env: cfg.env, homedir: cfg.home, run,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { projects: [{ key: "scratch", path: cfg.repo }] } } }) }),
  out: () => {}, warn: (line) => warn.push(line), breakdownRoot: "/opt/breakdown",
});
console.log(JSON.stringify({ exitCode, resolved, warn }));
`;
  async function inChild(fx, argv) {
    const cfg = {
      lib: pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "review-request-lib.mjs")).href,
      repo: fx.repo,
      cwd: fx.worktree,
      home: fx.home,
      env: CARD_ENV,
      argv,
    };
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...process.env, RR_CHILD: JSON.stringify(cfg) } }, (err, out, errOut) =>
        err ? reject(new Error(`${err.message}\n${errOut}`)) : resolve(out),
      );
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  }

  it("resolves no yaml module in a full image-form run, and does in a card run", async () => {
    const legacy = await inChild(await fixture(), [ITEM, "--summary", "check the header", "a.png"]);
    assert.deepEqual(legacy, { exitCode: 0, resolved: [], warn: [] });
    const card = await inChild(await fixture(), [ITEM, path.join(CARDS, "shlo-k54.4.1.1.md")]);
    assert.equal(card.exitCode, 0, card.warn.join("\n"));
    assert.deepEqual(card.resolved, ["yaml"]);
  });
});
