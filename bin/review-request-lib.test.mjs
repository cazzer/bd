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
  MAX_BODY_WORDS,
  MAX_VIDEO_BYTES,
  SUMMARY_WARN_CHARS,
  USAGE,
  apiBase,
  boardLink,
  chooseReview,
  copiedName,
  countBodyWords,
  findProject,
  paneFrom,
  socketFrom,
  parseArgs,
  parseJsonOutput,
  requestReview,
  reviewMetadata,
  splitCard,
  summaryWarning,
  validateCard,
  videoProblem,
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
    assert.match(h.warn[0], new RegExp(`^review-request: could not copy the attachments under ${fx.projectDir}: ENOENT.*b\\.png.*\\. Nothing was filed\\.$`));
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
  "invalid-question-too-long.md": ["question: at most 140 characters, got 160", "several decisions? one card each: review-request scr-1 a.md b.md …", "Nothing was filed."],
  "invalid-repeated-option-id.md": ["options[1].id: A repeats options[0].id", "Nothing was filed."],
  "invalid-recommend-unknown.md": ['recommend: "D" names no option (options: A, B, C)', "Nothing was filed."],
  "invalid-unknown-kind.md": ['attachments[0].kind: must be image, video, mermaid, or diff, got "pdf"', "Nothing was filed."],
  "invalid-video-option-unknown.md": ['attachments[0].option: "C" names no option (options: A, B)', "Nothing was filed."],
  "invalid-video-extension.md": ["attachments[0].path: not a video (mp4, webm): before.png", "Nothing was filed."],
  "invalid-unknown-key.md": ["recomend: unknown field (card fields: question, options, recommend, on_accept, attachments, key)", "Nothing was filed."],
  "invalid-body-over-budget.md": ["body: at most 300 words outside fenced blocks, got 315", "several decisions? one card each: review-request scr-1 a.md b.md …", "Nothing was filed."],
  "invalid-key.md": ['key: must be a lower-case letter or digit, then up to 39 lower-case letters, digits, _ or -; got "Has Spaces"', "Nothing was filed."],
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
    assert.deepEqual(parseArgs(["scr-1", "cards/x.md"]), { args: { itemId: "scr-1", cardPaths: ["cards/x.md"], boardUrl: BOARD } });
    assert.deepEqual(parseArgs(["scr-1", "x.md", "--board-url", "https://board.test"]), {
      args: { itemId: "scr-1", cardPaths: ["x.md"], boardUrl: "https://board.test" },
    });
    assert.match(parseArgs(["scr-1", "x.md", "--board-url", "file:///x"]).error, /http\(s\) URL/);
  });
  it("leaves every other shape to the image form", () => {
    assert.deepEqual(parseArgs(["scr-1", "--summary", "s", "x.md"]), {
      args: { itemId: "scr-1", summary: "s", boardUrl: BOARD, images: ["x.md"] },
    });
    assert.match(parseArgs(["scr-1", "x.md", "a.png"]).error, /card files and images can't be mixed/);
    assert.match(parseArgs(["scr-1", "x.markdown"]).error, /--summary is required/);
  });
  it("takes up to six cards, in order", () => {
    const six = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"];
    assert.deepEqual(parseArgs(["scr-1", "x.md", "y.md"]), { args: { itemId: "scr-1", cardPaths: ["x.md", "y.md"], boardUrl: BOARD } });
    assert.deepEqual(parseArgs(["scr-1", ...six]).args.cardPaths, six);
    assert.match(parseArgs(["scr-1", ...six, "g.md"]).error, /at most 6 cards in one call, got 7/);
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
      const { question, images, attachments = [] } = written.review;
      assert.deepEqual(h.calls.find((c) => c.cmd === "herdr").args, [
        "notification", "show", `Review requested: scratch ${ITEM}`, "--body", question.slice(0, 200), "--sound", "request",
      ]);
      // Every stored path (images, videos, posters) is staged, and nothing else is; NN counts staged files in order.
      const stored = attachments.flatMap((a) => [a.path, a.poster].filter((p) => p !== undefined));
      assert.deepEqual(images, attachments.flatMap((a) => (a.kind === "image" ? [a.path] : [])));
      assert.deepEqual(stored.map((p) => path.basename(p).slice(0, 3)), stored.map((_, i) => `${String(i + 1).padStart(2, "0")}-`));
      assert.deepEqual((await fs.readdir(dir)).sort(), stored.map((p) => path.basename(p)).sort());
      for (const file of stored) {
        const source = path.join(CARDS, path.basename(file).replace(/^\d\d-/, ""));
        assert.deepEqual(await fs.readFile(file), await fs.readFile(source));
      }
      const videos = attachments.filter((a) => a.kind === "video").length;
      const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
      const media = videos === 0 ? plural(images.length, "image") : `${plural(images.length, "image")}, ${plural(videos, "video")}`;
      assert.equal(h.out[0], `Review ${REVIEW} filed for ${ITEM} in scratch (${media}).`);
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

// ---- Cards stay short (design.md decision 8) ----

/** `n` words of prose, eight to a line. */
const prose = (n) =>
  Array.from({ length: n }, (_, i) => `w${i}`)
    .reduce((lines, word, i) => (i % 8 === 0 ? [...lines, word] : [...lines.slice(0, -1), `${lines.at(-1)} ${word}`]), [])
    .join("\n");

describe("countBodyWords", () => {
  it("counts whitespace-separated tokens holding a letter or digit", () => {
    assert.equal(countBodyWords(""), 0);
    assert.equal(countBodyWords("Drop v5–v8 on 11-12 — if zero calls ."), 7);
    assert.equal(countBodyWords("- * > # ## -- → ... |"), 0);
    assert.equal(countBodyWords("**bold** _it_ [link](http://x) 42 é"), 5);
  });
  it("leaves fenced blocks of both kinds out, with any info string", () => {
    assert.equal(countBodyWords("one\n```\nfree words here\n```\ntwo"), 2);
    assert.equal(countBodyWords("one\n```diff\n+free words\n```\ntwo"), 2);
    assert.equal(countBodyWords("one\n~~~ mermaid title=x\nerDiagram A B\n~~~\ntwo"), 2);
    assert.equal(countBodyWords("one\n   ```sql\nselect 1\n   ```\ntwo"), 2);
  });
  it("closes a fence only on the same character, at least as long, with nothing after it", () => {
    assert.equal(countBodyWords("````\nfree\n```\nstill free\n````\nafter"), 1);
    assert.equal(countBodyWords("```\nfree\n~~~\nstill free\n```\nafter"), 1);
    assert.equal(countBodyWords("~~~\nfree\n~~~ not a close\nstill free\n~~~~\nafter"), 1);
  });
  it("runs an unclosed fence to the end", () => {
    assert.equal(countBodyWords("one two\n```diff\n+a b c\nd e f"), 2);
  });
  it("is not a fence: two backticks, a backtick info string, four spaces of indent", () => {
    assert.equal(countBodyWords("``\nthree words here"), 3);
    assert.equal(countBodyWords("``` a`b\nc"), 2);
    assert.equal(countBodyWords("    ```\ncounted"), 1);
  });
  it("leaves out a fence nested in a list item, up to three spaces past the item's content column", () => {
    assert.equal(countBodyWords("1. Run:\n    ```bash\n    pnpm install now\n    ```\n2) Then go"), 3);
    assert.equal(countBodyWords("- Run:\n  ```\n  free\n  ```\n- next"), 2);
    assert.equal(countBodyWords("- Run:\n\n     ```\n     free\n     ```\n"), 1);
    assert.equal(countBodyWords("10. Run:\n     ~~~\n     free\n     ~~~\n"), 1);
    assert.equal(countBodyWords("- ```js\n  free words\n  ```\nafter"), 1);
  });
  it("counts a fence deeper than three spaces past the item's content column, and after the list has ended", () => {
    assert.equal(countBodyWords("- Run:\n      ```\n      counted\n      ```"), 2);
    assert.equal(countBodyWords("1. Run:\n\nA paragraph.\n\n    ```\n    counted words\n    ```"), 5);
  });
  it("leaves out a fence inside a blockquote", () => {
    assert.equal(countBodyWords("> Said:\n> ```\n> free words\n> ```\n> done"), 2);
    assert.equal(countBodyWords("> > ~~~\n> > free\n> > ~~~\nafter"), 1);
  });
  it("does not count an ordered-list marker opening a line", () => {
    assert.equal(countBodyWords("1. one\n2) two\n   3. three\n> 4. four"), 4);
    assert.equal(countBodyWords("Step 1. here"), 3);
    assert.equal(countBodyWords("1.5 is a number"), 4);
  });
  it("counts table cells and inline code, not pipes or separator rows", () => {
    assert.equal(countBodyWords("| Caller | Uses |\n| --- | :---: |\n| web-app | `v9` |"), 4);
    assert.equal(countBodyWords("Turn on `track_functions=all` now"), 4);
  });
  it("reads CRLF and CR line ends like LF", () => {
    assert.equal(countBodyWords("one\r\n```\r\nfree\r\n```\r\ntwo"), 2);
    assert.equal(countBodyWords("one\r```\rfree\r```\rtwo"), 2);
  });
  it("counts the shlo fixture at 278, within the budget", async () => {
    const { body } = splitCard(await fs.readFile(path.join(CARDS, "shlo-k54.4.1.1.md"), "utf8"));
    assert.equal(countBodyWords(body), 278);
    assert.equal(MAX_BODY_WORDS, 300);
  });
});

describe("card body word budget", () => {
  const cardWith = (body) => `---\nquestion: Ship it?\n---\n${body}\n`;
  it("files a body of exactly 300 words, fences free", async () => {
    const fx = await fixture();
    const card = await writeCard(fx, cardWith(`${prose(300)}\n\n\`\`\`diff\n${prose(500)}\n\`\`\``));
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(h.warn, []);
    assert.deepEqual(order(h.calls), FILED_ORDER);
  });
  it("reports only the character cap when a body is over both", async () => {
    const fx = await fixture();
    const body = prose(1600);
    assert.ok(body.length > 8000);
    const card = await writeCard(fx, cardWith(body));
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.deepEqual(h.warn, [`review-request: body: at most 8000 characters, got ${body.length}`, "review-request: several decisions? one card each: review-request scr-1 a.md b.md …", "review-request: Nothing was filed."]);
    await assertNothingFiled(fx, h);
  });
  it("refuses 301 words naming the budget and the count, with nothing filed", async () => {
    const fx = await fixture();
    const card = await writeCard(fx, cardWith(prose(301)));
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.deepEqual(h.warn, ["review-request: body: at most 300 words outside fenced blocks, got 301", "review-request: several decisions? one card each: review-request scr-1 a.md b.md …", "review-request: Nothing was filed."]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });
});

describe("long legacy summary", () => {
  const summaryOf = (n) => "s".repeat(n);
  const warning = (n) =>
    `review-request: warning: the summary is ${n} characters, over 280; a decision reads faster as a card, one card per decision: review-request ${ITEM} <card.md>... (examples: ${path.join(BREAKDOWN_ROOT, "fixtures", "review-cards")}).`;

  it("is quiet at 280 characters", async () => {
    assert.equal(SUMMARY_WARN_CHARS, 280);
    assert.equal(summaryWarning({ itemId: ITEM, summary: summaryOf(280) }, BREAKDOWN_ROOT), null);
    const h = await harness(await fixture(), { argv: [ITEM, "--summary", summaryOf(280), "a.png"] });
    assert.equal(h.result.exitCode, 0);
    assert.deepEqual(h.warn, []);
  });

  it("at 281 files exactly as at 280, then warns once on stderr naming the limit and the card form", async () => {
    const quiet = await harness(await fixture(), { argv: [ITEM, "--summary", summaryOf(280), "a.png"] });
    const loud = await harness(await fixture(), { argv: [ITEM, "--summary", summaryOf(281), "a.png"] });
    assert.equal(loud.result.exitCode, 0);
    assert.deepEqual(loud.out, quiet.out);
    assert.deepEqual(order(loud.calls), order(quiet.calls));
    assert.deepEqual(loud.warn, [warning(281)]);
    const create = callTo(loud, "create").args;
    assert.equal(create[create.indexOf("-d") + 1], summaryOf(281));
    const written = JSON.parse(callTo(loud, "update").args[3]);
    const quietWritten = JSON.parse(callTo(quiet, "update").args[3]);
    assert.equal(written.review.summary, summaryOf(281));
    assert.deepEqual({ ...written.review, summary: null, images: written.review.images.map((p) => path.basename(p)) }, {
      ...quietWritten.review,
      summary: null,
      images: quietWritten.review.images.map((p) => path.basename(p)),
    });
  });

  it("warns after the other warnings, and never when nothing was filed", async () => {
    const fx = await fixture();
    const unpaned = await harness(fx, { argv: [ITEM, "--summary", summaryOf(1000), "a.png"], env: {} });
    assert.equal(unpaned.result.exitCode, 0);
    assert.equal(unpaned.warn.at(-1), warning(1000));
    assert.equal(unpaned.warn.filter((l) => l.includes("warning: the summary")).length, 1);
    const refused = await harness(await fixture(), { argv: [ITEM, "--summary", summaryOf(1000), "gone.png"] });
    assert.equal(refused.result.exitCode, 1);
    assert.equal(refused.warn.some((l) => l.includes("warning: the summary")), false);
  });
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
        key: "card",
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
    assert.deepEqual(update.args.slice(4), ["--description", "Evidence, second pass.", "--remove-label", "review:changes", "--title", "Review: Ship it?"]);
    assert.deepEqual(JSON.parse(update.args[3]), {
      review: { images: [], pane: "w1:p2", socket: SOCKET, summary: "Ship it?", key: "card", question: "Ship it?" },
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
    ["an over-long body", `${QUESTION_ONLY}${LONG}\n`, ["body: at most 8000 characters, got 8001", "several decisions? one card each: review-request scr-1 a.md b.md …"]],
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
    assert.deepEqual(Object.keys(JSON.parse(callTo(h, "update").args[3]).review), ["images", "pane", "socket", "summary", "key", "question"]);
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

// ---- Videos (video-review-attachments, design.md decisions 2 and 3) ----

describe("videoProblem", () => {
  const file = (size) => ({ isFile: () => true, size });
  it("accepts an mp4 or webm up to 200 MB, any case of extension", () => {
    assert.equal(MAX_VIDEO_BYTES, 200 * 2 ** 20);
    assert.equal(videoProblem("reel.mp4", file(MAX_VIDEO_BYTES)), null);
    assert.equal(videoProblem("cuts/reel.WEBM", file(1)), null);
  });
  it("names a missing file, a non-video, and a directory", () => {
    assert.equal(videoProblem("gone.mp4", null), "video not found: gone.mp4");
    assert.equal(videoProblem("reel.avi", file(1)), "not a video (mp4, webm): reel.avi");
    assert.equal(videoProblem("reel.mp4", { isFile: () => false, size: 0 }), "not a video (mp4, webm): reel.mp4");
  });
  it("gives the remux command for a QuickTime file", () => {
    assert.equal(videoProblem("reel.mov", file(1)), "not a video (mp4, webm): reel.mov; remux it: ffmpeg -i reel.mov -c copy reel.mp4");
    assert.equal(videoProblem("cuts/Reel.MOV", file(1)), "not a video (mp4, webm): cuts/Reel.MOV; remux it: ffmpeg -i cuts/Reel.MOV -c copy cuts/Reel.mp4");
  });
  it("names the size in MB, rounded up, over the cap", () => {
    assert.equal(videoProblem("reel.mp4", file(MAX_VIDEO_BYTES + 1)), "video is 201 MB, over the 200 MB limit: reel.mp4");
    assert.equal(videoProblem("reel.mp4", file(250 * 2 ** 20)), "video is 250 MB, over the 200 MB limit: reel.mp4");
  });
});

describe("video attachments", () => {
  /** A card under the caller worktree's `cards/`, with `files` (name → contents) written beside it. */
  async function videoCard(fx, frontmatter, files = {}) {
    const card = await writeCard(fx, `---\n${frontmatter}---\n`);
    for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(fx.worktree, "cards", name), contents);
    return card;
  }
  const AB = "options:\n  - { id: A, label: a }\n  - { id: B, label: b }\n";

  it("numbers staged files in attachment order, a poster after its video, and lists images alone as legacy images", async () => {
    const fx = await fixture();
    const card = await videoCard(
      fx,
      `question: Which cut?\n${AB}attachments:\n  - { kind: image, path: ../a.png }\n  - { kind: video, path: cut.mp4, poster: cut.jpg, caption: Cut, option: B }\n  - { kind: image, path: ../b.png }\n  - { kind: video, path: raw.webm }\n`,
      { "cut.mp4": "V1", "cut.jpg": "P1", "raw.webm": "W1" },
    );
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    const dir = path.join(fx.projectDir, REVIEW);
    const { review } = JSON.parse(callTo(h, "update").args[3]);
    assert.deepEqual(review.images, [path.join(dir, "01-a.png"), path.join(dir, "04-b.png")]);
    assert.equal(
      JSON.stringify(review.attachments),
      JSON.stringify([
        { kind: "image", path: path.join(dir, "01-a.png") },
        { kind: "video", path: path.join(dir, "02-cut.mp4"), poster: path.join(dir, "03-cut.jpg"), caption: "Cut", option: "B" },
        { kind: "image", path: path.join(dir, "04-b.png") },
        { kind: "video", path: path.join(dir, "05-raw.webm") },
      ]),
    );
    assert.deepEqual((await fs.readdir(dir)).sort(), ["01-a.png", "02-cut.mp4", "03-cut.jpg", "04-b.png", "05-raw.webm"]);
    assert.equal(await fs.readFile(path.join(dir, "03-cut.jpg"), "utf8"), "P1");
    assert.equal(h.out[0], `Review ${REVIEW} filed for ${ITEM} in scratch (2 images, 2 videos).`);
  });

  it("refuses a video over 200 MB naming its size, with nothing filed", async () => {
    const fx = await fixture();
    const card = await videoCard(fx, "question: Q?\nattachments:\n  - { kind: video, path: reel.mp4 }\n");
    // Sparse: the size is what is checked, never the content.
    await fs.truncate(await (async () => {
      const file = path.join(fx.worktree, "cards", "reel.mp4");
      await fs.writeFile(file, "");
      return file;
    })(), 250 * 2 ** 20);
    const h = await harness(fx, { argv: [ITEM, card] });
    assert.deepEqual(h.warn, ["review-request: attachments[0].path: video is 250 MB, over the 200 MB limit: reel.mp4", "review-request: Nothing was filed."]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });

  const refusals = [
    ["a missing video", "question: Q?\nattachments:\n  - { kind: video, path: gone.mp4 }\n", {}, ["attachments[0].path: video not found: gone.mp4"]],
    [
      "a QuickTime video, with the remux command",
      "question: Q?\nattachments:\n  - { kind: video, path: reel.mov }\n",
      { "reel.mov": "Q" },
      ["attachments[0].path: not a video (mp4, webm): reel.mov; remux it: ffmpeg -i reel.mov -c copy reel.mp4"],
    ],
    ["a video path that is not text", "question: Q?\nattachments:\n  - { kind: video, path: [a] }\n", {}, ["attachments[0].path: must be the path of a video, relative to the card, got a list"]],
    [
      "a missing poster and a non-image poster",
      "question: Q?\nattachments:\n  - { kind: video, path: v.mp4, poster: gone.jpg }\n  - { kind: video, path: v.mp4, poster: ../notes.txt }\n",
      { "v.mp4": "V" },
      ["attachments[0].poster: image not found: gone.jpg", "attachments[1].poster: not an image (png, jpg, jpeg, gif, webp): ../notes.txt"],
    ],
    ["an option without options", "question: Q?\nattachments:\n  - { kind: video, path: v.mp4, option: A }\n", { "v.mp4": "V" }, ["attachments[0].option: allowed only with options"]],
    [
      "an option that names no option",
      `question: Q?\n${AB}attachments:\n  - { kind: video, path: v.mp4, option: C }\n`,
      { "v.mp4": "V" },
      ['attachments[0].option: "C" names no option (options: A, B)'],
    ],
    [
      "a numeric option",
      'question: Q?\noptions:\n  - { id: "1", label: a }\n  - { id: "2", label: b }\nattachments:\n  - { kind: video, path: v.mp4, option: 1 }\n',
      { "v.mp4": "V" },
      ['attachments[0].option: got the number 1; quote it: option: "1"'],
    ],
    [
      "two videos naming one option",
      `question: Q?\n${AB}attachments:\n  - { kind: video, path: v.mp4, option: A }\n  - { kind: mermaid, source: x }\n  - { kind: video, path: v.mp4, option: A }\n`,
      { "v.mp4": "V" },
      ["attachments[2].option: A already has a video (attachments[0])"],
    ],
    [
      "option and pair together",
      `question: Q?\n${AB}attachments:\n  - { kind: video, path: v.mp4, option: A, pair: before }\n`,
      { "v.mp4": "V" },
      ["attachments[0]: option and pair can't both be set"],
    ],
    [
      "an option on an image",
      `question: Q?\n${AB}attachments:\n  - { kind: image, path: ../a.png, option: A }\n`,
      {},
      ["attachments[0].option: not a field of an image attachment (fields: kind, path, caption, pair)"],
    ],
    [
      "an unknown key on a video",
      "question: Q?\nattachments:\n  - { kind: video, path: v.mp4, autoplay: true }\n",
      { "v.mp4": "V" },
      ["attachments[0].autoplay: not a field of a video attachment (fields: kind, path, poster, caption, pair, option)"],
    ],
  ];
  for (const [what, frontmatter, files, problems] of refusals) {
    it(`refuses ${what}, naming the field, before any lookup`, async () => {
      const fx = await fixture();
      const h = await harness(fx, { argv: [ITEM, await videoCard(fx, frontmatter, files)] });
      assert.deepEqual(h.warn, [...problems, "Nothing was filed."].map((line) => `review-request: ${line}`));
      assert.deepEqual(h.calls, []);
      await assertNothingFiled(fx, h);
    });
  }

  it("the image form takes no video", async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.worktree, "reel.mp4"), "V");
    const h = await harness(fx, { argv: [ITEM, "--summary", "s", "reel.mp4"] });
    assert.deepEqual(h.warn, ["review-request: not an image (png, jpg, jpeg, gif, webp): reel.mp4", "review-request: Nothing was filed."]);
    await assertNothingFiled(fx, h);
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
    const long = await harness(fx, { importYaml, argv: [ITEM, "--summary", "s".repeat(281), "a.png"] });
    assert.equal(long.result.exitCode, 0);
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
    const long = await inChild(await fixture(), [ITEM, "--summary", "s".repeat(281), "a.png"]);
    assert.equal(long.exitCode, 0);
    assert.deepEqual(long.resolved, []);
    assert.equal(long.warn.length, 1);
    assert.match(long.warn[0], /^review-request: warning: the summary is 281 characters, over 280; /);
    const card = await inChild(await fixture(), [ITEM, path.join(CARDS, "shlo-k54.4.1.1.md")]);
    assert.equal(card.exitCode, 0, card.warn.join("\n"));
    assert.deepEqual(card.resolved, ["yaml"]);
  });
});

// ---- Several cards, matched by key (split-review-decisions) ----

const cardText = (question, extra = "") => `---\nquestion: "${question}"\n${extra}---\nEvidence for ${question}\n`;
const createdAs = (args, n) => ok(JSON.stringify({ id: `${ITEM}.${n}`, title: args[2] }));
const updatesOf = (h) => h.calls.filter((c) => c.cmd === "bd" && c.args[0] === "update");
const keyed = (id, key, extra = {}) => ({
  id,
  created_at: "2026-11-10T00:00:00Z",
  labels: ["review"],
  title: `Review: ${key}?`,
  metadata: { review: { images: [], pane: "w0:p0", summary: `${key}?`, key, question: `${key}?` } },
  ...extra,
});

describe("several cards in one call", () => {
  it("files one review per card with one lookup, one board link, and one notification", async () => {
    const fx = await fixture();
    const cards = [];
    for (const name of ["city", "budget", "logos", "gates"]) cards.push(await writeCard(fx, cardText(`Which ${name}?`), `${name}.md`));
    const h = await harness(fx, { argv: [ITEM, ...cards], handlers: { "bd create --title": createdAs } });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(order(h.calls), [
      "git rev-parse", "bd show", "bd list",
      "bd create", "bd update", "bd dep",
      "bd create", "bd update", "bd dep",
      "bd create", "bd update", "bd dep",
      "bd create", "bd update", "bd dep",
      "osascript -e", "open -a", "herdr notification",
    ]);
    const creates = h.calls.filter((c) => c.args[0] === "create");
    assert.deepEqual(creates.map((c) => c.args[2]), ["Review: Which city?", "Review: Which budget?", "Review: Which logos?", "Review: Which gates?"]);
    assert.deepEqual(updatesOf(h).map((c) => JSON.parse(c.args[3]).review.key), ["city", "budget", "logos", "gates"]);
    assert.deepEqual(h.calls.filter((c) => c.args[0] === "dep").map((c) => c.args[3]), [`${ITEM}.1`, `${ITEM}.2`, `${ITEM}.3`, `${ITEM}.4`]);
    assert.deepEqual(h.calls.find((c) => c.cmd === "herdr").args.slice(0, 5), [
      "notification", "show", `4 reviews requested: scratch ${ITEM}`, "--body", "Which city? · Which budget? · Which logos? · Which gates?",
    ]);
    assert.deepEqual(h.calls.find((c) => c.cmd === "open").args, ["-a", "Google Chrome", `${BOARD}/board?project=scratch&item=${ITEM}.1`]);
    assert.deepEqual(h.warn, []);
    assert.deepEqual(h.out, [
      `Review ${ITEM}.1 filed for ${ITEM} in scratch (key city, 0 images): Which city?`,
      `Review ${ITEM}.2 filed for ${ITEM} in scratch (key budget, 0 images): Which budget?`,
      `Review ${ITEM}.3 filed for ${ITEM} in scratch (key logos, 0 images): Which logos?`,
      `Review ${ITEM}.4 filed for ${ITEM} in scratch (key gates, 0 images): Which gates?`,
      `Board: ${BOARD}/board?project=scratch&item=${ITEM}.1`,
      "End your turn now and wait for one prompt in this pane per review (Review <id> accepted|changes requested: …); each is decided on its own. If none arrives, read `bd comments <id>`.",
    ]);
    for (const n of [1, 2, 3, 4]) assert.deepEqual(await fs.readdir(path.join(fx.projectDir, `${ITEM}.${n}`)), []);
  });

  it("refuses the whole call, before any lookup, when one card is bad", async () => {
    const fx = await fixture();
    const a = await writeCard(fx, cardText("A?"), "a.md");
    const b = await writeCard(fx, cardText("B?", "options:\n  - { id: X, label: x }\n  - { id: Y, label: y }\nrecommend: Z\n"), "b.md");
    const c = await writeCard(fx, cardText("C?"), "c.md");
    const h = await harness(fx, { argv: [ITEM, a, b, c] });
    assert.deepEqual(h.warn, [`review-request: ${b}: recommend: "Z" names no option (options: X, Y)`, "review-request: Nothing was filed."]);
    assert.deepEqual(h.calls, []);
    await assertNothingFiled(fx, h);
  });

  it("prefixes each card's problems and adds the split hint once", async () => {
    const fx = await fixture();
    const a = await writeCard(fx, `---\nquestion: "A?"\n---\n${prose(301)}\n`, "a.md");
    const b = await writeCard(fx, cardText("q".repeat(141)), "b.md");
    const h = await harness(fx, { argv: [ITEM, a, b] });
    assert.deepEqual(h.warn, [
      `review-request: ${a}: body: at most 300 words outside fenced blocks, got 301`,
      `review-request: ${b}: question: at most 140 characters, got 141`,
      "review-request: several decisions? one card each: review-request scr-1 a.md b.md …",
      "review-request: Nothing was filed.",
    ]);
    await assertNothingFiled(fx, h);
  });

  it("refuses two cards with the same key, naming both", async () => {
    const fx = await fixture();
    const a = await writeCard(fx, cardText("A?", "key: layout\n"), "a.md");
    const b = await writeCard(fx, cardText("B?", "key: layout\n"), "b.md");
    const h = await harness(fx, { argv: [ITEM, a, b] });
    assert.deepEqual(h.warn, [`review-request: key layout: set by ${a} and ${b}; each card needs its own key`, "review-request: Nothing was filed."]);
    await assertNothingFiled(fx, h);
  });

  it("refuses a filename that gives no key unless the frontmatter sets one", async () => {
    const fx = await fixture();
    const bad = await writeCard(fx, cardText("A?"), "___.md");
    const h = await harness(fx, { argv: [ITEM, bad] });
    assert.deepEqual(h.warn, [
      "review-request: key: the filename ___.md gives no usable key; set one in the frontmatter (a lower-case letter or digit, then up to 39 lower-case letters, digits, _ or -)",
      "review-request: Nothing was filed.",
    ]);
    await assertNothingFiled(fx, h);
    const named = await writeCard(fx, cardText("A?", "key: first\n"), "___.md");
    const ok2 = await harness(fx, { argv: [ITEM, named] });
    assert.equal(ok2.result.exitCode, 0, ok2.warn.join("\n"));
    assert.equal(JSON.parse(callTo(ok2, "update").args[3]).review.key, "first");
  });

  it("re-running one card of four updates only its review", async () => {
    const fx = await fixture();
    const children = ["city", "budget", "logos", "gates"].map((key, i) => keyed(`${ITEM}.${i + 1}`, key));
    children[2].labels = ["review", "review:changes"];
    const item = { id: ITEM, title: "Epic", issue_type: "epic", dependencies: [] };
    const card = await writeCard(fx, cardText("Which logos, revised?"), "logos.md");
    const h = await harness(fx, { item, children, argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "create"), undefined);
    const updates = updatesOf(h);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].args[1], `${ITEM}.3`);
    assert.deepEqual(updates[0].args.slice(4), ["--description", "Evidence for Which logos, revised?", "--remove-label", "review:changes", "--title", "Review: Which logos, revised?"]);
    assert.deepEqual(callTo(h, "comments").args, ["comments", "add", `${ITEM}.3`, "Review updated: Which logos, revised?"]);
    assert.equal(h.out[0], `Review ${ITEM}.3 updated for ${ITEM} in scratch (0 images).`);
    assert.equal(h.out[1], `Also open under ${ITEM}: ${ITEM}.1 (key city), ${ITEM}.2 (key budget), ${ITEM}.4 (key gates).`);
  });

  it("does not retitle a reused review whose title already names its question", async () => {
    const fx = await fixture();
    const card = await writeCard(fx, cardText("logos?"), "logos.md");
    const h = await harness(fx, { children: [keyed(`${ITEM}.3`, "logos")], argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "update").args.includes("--title"), false);
  });

  it("a multi-card call leaves a keyless review alone and warns about it", async () => {
    const fx = await fixture();
    const legacy = { id: `${ITEM}.1`, created_at: "2026-10-01T00:00:00Z", labels: ["review"], metadata: { review: { images: [], summary: "old" } } };
    const a = await writeCard(fx, cardText("A?"), "a.md");
    const b = await writeCard(fx, cardText("B?"), "b.md");
    const h = await harness(fx, { children: [legacy], argv: [ITEM, a, b], handlers: { "bd create --title": (args, n) => ok(JSON.stringify({ id: `${ITEM}.${n + 1}` })) } });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(updatesOf(h).map((c) => c.args[1]), [`${ITEM}.2`, `${ITEM}.3`]);
    assert.deepEqual(h.warn, [`review-request: open review ${ITEM}.1 under ${ITEM} has no key, so this call left it alone; close it or re-file it from a card.`]);
    assert.ok(h.out.includes(`Also open under ${ITEM}: ${ITEM}.1 (no key).`));
  });

  it("a single card reuses a keyless review and records its key", async () => {
    const fx = await fixture();
    const legacy = { id: REVIEW, created_at: "2026-10-01T00:00:00Z", labels: ["review"], metadata: { review: { images: [], summary: "old", question: "old" } } };
    const card = await writeCard(fx, cardText("New?"));
    const h = await harness(fx, { children: [legacy, keyed(`${ITEM}.9`, "other")], argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "create"), undefined);
    assert.equal(callTo(h, "update").args[1], REVIEW);
    assert.equal(JSON.parse(callTo(h, "update").args[3]).review.key, "card");
  });

  it("the image form never reuses a keyed review", async () => {
    const fx = await fixture();
    const h = await harness(fx, { children: [keyed(`${ITEM}.5`, "a"), keyed(`${ITEM}.6`, "b")] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "create").args[2], "Review: Board header");
    assert.equal(callTo(h, "update").args[1], REVIEW);
    assert.equal("key" in JSON.parse(callTo(h, "update").args[3]).review, false);
  });

  it("warns naming the count when several open reviews share a key", async () => {
    const fx = await fixture();
    const older = keyed(`${ITEM}.1`, "a", { created_at: "2026-11-01T00:00:00Z" });
    const newer = keyed(`${ITEM}.2`, "a", { created_at: "2026-11-02T00:00:00Z" });
    const card = await writeCard(fx, cardText("a?"), "a.md");
    const h = await harness(fx, { children: [older, newer], argv: [ITEM, card] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.equal(callTo(h, "update").args[1], `${ITEM}.2`);
    assert.deepEqual(h.warn, [`review-request: 2 open reviews for ${ITEM} with key a; reusing the newest, ${ITEM}.2.`]);
  });

  it("a failure partway names what was filed, and a re-run finishes without duplicates", async () => {
    const fx = await fixture();
    const cards = [];
    for (const name of ["a", "b", "c"]) cards.push(await writeCard(fx, cardText(`${name}?`), `${name}.md`));
    const first = await harness(fx, {
      argv: [ITEM, ...cards],
      handlers: { "bd create --title": (args, n) => (n === 2 ? fail("database is locked") : createdAs(args, n)) },
    });
    assert.equal(first.result.exitCode, 1);
    assert.deepEqual(first.warn, [
      `review-request: bd create failed in ${fx.repo}: database is locked.`,
      `review-request: stopped at ${cards[1]}; filed so far: ${ITEM}.1. Re-run the same command to retry; it reuses filed reviews by key and files the rest.`,
    ]);
    assert.equal(first.calls.some((c) => c.cmd === "herdr" || c.cmd === "open"), false);

    const filed = keyed(`${ITEM}.1`, "a");
    const again = await harness(fx, {
      children: [filed],
      argv: [ITEM, ...cards],
      handlers: { "bd create --title": (args, n) => createdAs(args, n + 1) },
    });
    assert.equal(again.result.exitCode, 0, again.warn.join("\n"));
    assert.deepEqual(again.calls.filter((c) => c.args[0] === "create").map((c) => c.args[2]), ["Review: b?", "Review: c?"]);
    assert.deepEqual(updatesOf(again).map((c) => c.args[1]), [`${ITEM}.1`, `${ITEM}.2`, `${ITEM}.3`]);
  });

  it("cuts a card review's title to 120 characters", async () => {
    const fx = await fixture();
    const question = `${"q".repeat(139)}?`;
    const h = await harness(fx, { argv: [ITEM, await writeCard(fx, cardText(question))] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    const title = callTo(h, "create").args[2];
    assert.equal(title.length, 120);
    assert.equal(title, `Review: ${question}`.slice(0, 120));
  });
});

describe("card-first usage", () => {
  it("leads --help with the card form and the one-decision rule", async () => {
    const fx = await fixture();
    const h = await harness(fx, { argv: ["--help"] });
    assert.equal(h.result.exitCode, 0);
    const lines = h.out.join("\n").split("\n");
    assert.equal(lines[0], "usage: review-request <item-id> <card.md>... [--board-url <url>]");
    assert.match(h.out.join("\n"), /One decision per card\. Several decisions are several cards in one call/);
    assert.match(h.out.join("\n"), /never in an image/);
    assert.match(h.out.join("\n"), /keep a card's\nfilename across revisions, or set `key:`/);
  });

  it("judges no summary wording and no image filename", async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.worktree, "01-card.png"), "C");
    await fs.writeFile(path.join(fx.worktree, "contact-sheet.png"), "S");
    const h = await harness(fx, { argv: [ITEM, "--summary", "Decide: A or B? Rec: A", "01-card.png", "contact-sheet.png"] });
    assert.equal(h.result.exitCode, 0, h.warn.join("\n"));
    assert.deepEqual(h.warn, []);
  });
});
