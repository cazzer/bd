// review-request: files or refreshes a review bead for an item and points the
// breakdown board at it. Plain Node ESM with no dependencies so it runs from
// any checkout without the workspace toolchain (design decision 7 of
// openspec/changes/board-visual-reviews). Every external effect — git, bd,
// open, herdr, fetch — is injected so the flow is testable without them.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const USAGE = "usage: review-request <item-id> --summary <text> [--board-url <url>] <image>...";
const PREFIX = "review-request: ";

// Must agree with REVIEW_IMAGE_ROOT in packages/core/src/reviews.ts: the
// server serves review images only from under this directory.
export const REVIEW_ROOT_PARTS = [".local", "share", "breakdown", "reviews"];

export const DEFAULT_BOARD_URL = "http://localhost:5310";
const DEFAULT_SERVER_PORT = "4310";
const FETCH_TIMEOUT_MS = 5_000;
// The first character is never `-`, so an id cannot be read by bd as an option.
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PORT = /^\d{1,5}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Must agree with REVIEW_PANE_PATTERN in packages/core/src/reviews.ts; never starts with `-`.
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
// Must agree with isReviewSocketPath in packages/core/src/reviews.ts.
const MAX_SOCKET_PATH = 512;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_SUMMARY = 2000;
const MAX_IMAGES = 20;
const MAX_TITLE = 120;
const MAX_NOTIFICATION_BODY = 200;
const REVIEW_LABEL = "review";
const CHANGES_LABEL = "review:changes";
const OPEN_STATUSES = "open,in_progress,blocked,deferred";

/** @returns {{ help: true } | { error: string } | { args: { itemId: string, summary: string, boardUrl: string, images: string[] } }} */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        summary: { type: "string" },
        "board-url": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [itemId, ...images] = positionals;
  if (itemId === undefined) return { error: "missing <item-id>" };
  if (!ITEM_ID.test(itemId)) return { error: `not an issue id: ${itemId}` };
  const summary = values.summary?.trim();
  if (!summary) return { error: "--summary is required" };
  if (summary.length > MAX_SUMMARY) return { error: `--summary is longer than ${MAX_SUMMARY} characters` };
  if (images.length === 0) return { error: "at least one image is required" };
  if (images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images, got ${images.length}` };
  const boardUrl = values["board-url"] ?? DEFAULT_BOARD_URL;
  if (!isHttpUrl(boardUrl)) return { error: `--board-url must be an http(s) URL: ${boardUrl}` };
  return { args: { itemId, summary, boardUrl, images } };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function apiBase(env) {
  const port = PORT.test(env.WEB_SERVER_PORT ?? "") ? env.WEB_SERVER_PORT : DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${port}`;
}

export function boardLink(boardUrl, project, itemId) {
  const base = boardUrl.replace(/\/+$/, "");
  return `${base}/board?project=${encodeURIComponent(project)}&item=${encodeURIComponent(itemId)}`;
}

/** @param stat an fs.Stats for the path, or null when it does not exist. */
export function imageProblem(imagePath, stat) {
  if (stat === null) return `image not found: ${imagePath}`;
  if (!stat.isFile() || !IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
    return `not an image (png, jpg, jpeg, gif, webp): ${imagePath}`;
  }
  return null;
}

export function copiedName(index, src) {
  const base = path.basename(src).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${String(index + 1).padStart(2, "0")}-${base}`;
}

/** The main working tree is the parent of the shared git dir, from a worktree or the checkout itself. */
export function mainWorktree(commonDir) {
  return path.dirname(commonDir);
}

function realpathOr(p, realpathFn) {
  try {
    return realpathFn(p);
  } catch {
    return p;
  }
}

export function findProject(projects, realMain, realpathFn = realpathSync) {
  return projects.find((project) => realpathOr(project.path, realpathFn) === realMain) ?? null;
}

/** The newest open review child is reused; older duplicates are left alone. */
export function chooseReview(children) {
  if (children.length === 0) return null;
  const time = (child) => {
    const parsed = Date.parse(child.created_at);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  const newest = [...children].sort((a, b) => time(b) - time(a))[0];
  return { review: newest, count: children.length };
}

/** `bd update --metadata` merges top-level keys and replaces each one whole, so sending `review` alone keeps the rest. */
export function reviewMetadata({ images, pane, socket = null, summary }) {
  return {
    review: { images, ...(pane === null ? {} : { pane }), ...(socket === null ? {} : { socket }), summary },
  };
}

export function paneFrom(env) {
  const pane = env.HERDR_PANE_ID;
  return typeof pane === "string" && PANE_ID.test(pane) ? pane : null;
}

/** The herdr server socket the pane id belongs to: pane ids are scoped to one herdr server, so the board prompts through this socket. */
export function socketFrom(env) {
  const socket = env.HERDR_SOCKET_PATH;
  return typeof socket === "string" &&
    socket.length > 0 &&
    socket.length <= MAX_SOCKET_PATH &&
    !CONTROL_CHAR.test(socket) &&
    path.isAbsolute(socket)
    ? socket
    : null;
}

/** bd sometimes prints warnings before its JSON; parse from the first bracket. */
export function parseJsonOutput(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1) throw new Error("no JSON in output");
  return JSON.parse(stdout.slice(start));
}

function firstLine(result) {
  const text = (result.stderr || result.stdout || "").trim();
  return text.split("\n")[0] || `exit ${result.code}`;
}

function blocksOn(item, id) {
  return (item.dependencies ?? []).some(
    (dep) => (dep.id ?? dep.depends_on_id) === id && (dep.dependency_type ?? dep.type) === "blocks",
  );
}

class Refusal extends Error {}

async function fetchProjects(fetchFn, url) {
  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`);
    throw new Error(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err));
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("response was not JSON");
  }
  const projects = body?.result?.data?.projects;
  if (
    !Array.isArray(projects) ||
    !projects.every((p) => typeof p?.key === "string" && typeof p?.path === "string")
  ) {
    throw new Error("unexpected response shape");
  }
  return projects;
}

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

function reviewDir(homedir, key) {
  return path.join(homedir, ...REVIEW_ROOT_PARTS, key);
}

// Reusing a board tab, not opening another: every open board tab holds a
// live-update stream, and Chrome allows six HTTP/1.1 connections per host,
// so enough board tabs starve the review decision's POST. The script finds
// the first Chrome tab under the board's base URL, points it at the link,
// and brings it front. It never launches Chrome (a `tell` would), and the
// URLs arrive as argv, never interpolated into the script text. It prints
// `reused` or `none`; anything but `reused` falls back to `open`.
export const CHROME_REUSE_TAB_SCRIPT = `on run argv
  set boardPrefix to item 1 of argv
  set targetUrl to item 2 of argv
  if application "Google Chrome" is not running then return "none"
  tell application "Google Chrome"
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        if (URL of t) starts with boardPrefix then
          set URL of t to targetUrl
          set active tab index of w to tabIndex
          set index of w to 1
          activate
          return "reused"
        end if
      end repeat
    end repeat
  end tell
  return "none"
end run`;

async function showInChrome(deps, boardUrl, link) {
  // The trailing slash keeps http://localhost:5310 from matching :53100.
  const boardPrefix = `${boardUrl.replace(/\/+$/, "")}/`;
  const reused = await deps.run("osascript", ["-e", CHROME_REUSE_TAB_SCRIPT, boardPrefix, link], { cwd: deps.cwd });
  if (reused.code === 0 && reused.stdout.trim() === "reused") return;
  if (reused.code !== 0) deps.warn(`${PREFIX}could not reuse a board tab (${firstLine(reused)}); opening a new one.`);
  const opened = await deps.run("open", ["-a", "Google Chrome", link], { cwd: deps.cwd });
  if (opened.code !== 0) deps.warn(`${PREFIX}could not open Chrome (${firstLine(opened)}); open ${link} yourself.`);
}

/**
 * @param deps {{ argv: string[], cwd: string, env: Record<string, string|undefined>, homedir: string,
 *   run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   fetch: typeof fetch, out: (line: string) => void, warn: (line: string) => void, breakdownRoot: string }}
 * @returns {Promise<{ exitCode: number }>}
 */
export async function requestReview(deps) {
  const parsed = parseArgs(deps.argv);
  if ("help" in parsed) {
    deps.out(USAGE);
    return { exitCode: 0 };
  }
  if ("error" in parsed) {
    deps.warn(PREFIX + parsed.error);
    deps.warn(USAGE);
    return { exitCode: 2 };
  }
  let staged = null;
  try {
    const plan = await check(deps, parsed.args);
    staged = await stageImages(deps, plan.project.key, parsed.args.images);
    return await write(deps, parsed.args, plan, staged);
  } catch (err) {
    const message = err instanceof Refusal ? err.message : `unexpected error: ${err?.message ?? String(err)}`;
    for (const line of message.split("\n")) deps.warn(PREFIX + line);
    return { exitCode: 1 };
  } finally {
    // Already gone once the images were moved into place; on any other path nothing may be left behind.
    if (staged) await fs.rm(staged.dir, { recursive: true, force: true });
  }
}

/** Everything that can refuse runs here, before any write. */
async function check(deps, args) {
  const images = args.images.map((given) => ({ given, abs: path.resolve(deps.cwd, given) }));
  const problems = [];
  for (const image of images) {
    const problem = imageProblem(image.given, await statOrNull(image.abs));
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) throw new Refusal([...problems, "Nothing was filed."].join("\n"));

  const git = await deps.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: deps.cwd });
  if (git.code !== 0 || !git.stdout.trim()) {
    throw new Refusal(
      `${deps.cwd} is not inside a git checkout; run it from a registered checkout or one of its worktrees.`,
    );
  }
  const main = mainWorktree(git.stdout.trim());
  const realMain = realpathOr(main, realpathSync);

  const api = apiBase(deps.env);
  let projects;
  try {
    projects = await fetchProjects(deps.fetch, `${api}/trpc/beadsProjects`);
  } catch (err) {
    throw new Refusal(
      `cannot reach the breakdown server at ${api}/trpc/beadsProjects (${err.message}). Start it with \`pnpm dev\` in ${deps.breakdownRoot}, then retry. Nothing was filed.`,
    );
  }
  const project = findProject(projects, realMain);
  if (!project) {
    throw new Refusal(
      `checkout ${main} is not registered with breakdown. Register it with: cd ${deps.breakdownRoot} && pnpm ingest:beads ${main} --project <key>. Nothing was filed.`,
    );
  }
  if (!SAFE_SEGMENT.test(project.key)) {
    throw new Refusal(`project key ${JSON.stringify(project.key)} is not usable as a directory name. Nothing was filed.`);
  }
  // The directory we resolved ourselves, not the server's string for it; findProject proved they are the same.
  const bdCwd = { cwd: realMain };

  const shown = await deps.run("bd", ["show", args.itemId, "--json"], bdCwd);
  let item = null;
  let reason = firstLine(shown);
  if (shown.code === 0) {
    try {
      const parsedShow = parseJsonOutput(shown.stdout);
      item = Array.isArray(parsedShow) ? (parsedShow[0] ?? null) : parsedShow;
    } catch {
      reason = "unreadable output from bd show";
    }
    if (!item) reason = "bd show returned nothing";
  }
  if (!item) {
    throw new Refusal(`no issue ${args.itemId} in project ${project.key} (${project.path}): ${reason}. Nothing was filed.`);
  }

  const listed = await deps.run(
    "bd",
    ["list", "--parent", args.itemId, "--label", REVIEW_LABEL, "--status", OPEN_STATUSES, "--limit", "0", "--json"],
    bdCwd,
  );
  let children;
  try {
    if (listed.code !== 0) throw new Error(firstLine(listed));
    children = parseJsonOutput(listed.stdout);
    if (!Array.isArray(children)) throw new Error("unreadable output from bd list");
  } catch (err) {
    throw new Refusal(`cannot list open reviews of ${args.itemId} in ${project.key}: ${err.message}. Nothing was filed.`);
  }
  return { project, item, existing: chooseReview(children), bdCwd };
}

/** Copies the images before any bead is filed, so a copy failure refuses with nothing filed. */
async function stageImages(deps, key, images) {
  const projectDir = reviewDir(deps.homedir, key);
  let dir = null;
  try {
    await fs.mkdir(projectDir, { recursive: true });
    dir = await fs.mkdtemp(path.join(projectDir, `.staging-${process.pid}-`));
    const names = [];
    for (const [index, given] of images.entries()) {
      const name = copiedName(index, given);
      await fs.copyFile(path.resolve(deps.cwd, given), path.join(dir, name));
      names.push(name);
    }
    return { dir, names };
  } catch (err) {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    throw new Refusal(`could not copy the images under ${projectDir}: ${err.message}. Nothing was filed.`);
  }
}

/** Swaps the staged images in as the bead's directory; the previous images stay until the new ones are in place. */
async function placeImages(deps, key, id, staged) {
  const projectDir = reviewDir(deps.homedir, key);
  const finalDir = path.join(projectDir, id);
  const oldDir = path.join(projectDir, `.old-${id}-${process.pid}`);
  await fs.rm(oldDir, { recursive: true, force: true });
  let hadOld = false;
  try {
    await fs.rename(finalDir, oldDir);
    hadOld = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    await fs.rename(staged.dir, finalDir);
  } catch (err) {
    if (hadOld) await fs.rename(oldDir, finalDir);
    throw err;
  }
  if (hadOld) await fs.rm(oldDir, { recursive: true, force: true });
  return staged.names.map((name) => path.join(finalDir, name));
}

/** A reused bead with images on record finished a request before; one without is a retry of a failed first request. */
function hadImages(review) {
  const images = review.metadata?.review?.images;
  return Array.isArray(images) && images.length > 0;
}

async function write(deps, args, { project, item, existing, bdCwd }, staged) {
  const pane = paneFrom(deps.env);
  const socket = socketFrom(deps.env);
  let review;
  if (existing) {
    review = existing.review;
    if (existing.count > 1) {
      deps.warn(`${PREFIX}${existing.count} open reviews for ${args.itemId}; reusing the newest, ${review.id}.`);
    }
  } else {
    const title = `Review: ${String(item.title ?? args.itemId).slice(0, MAX_TITLE)}`;
    const created = await deps.run(
      "bd",
      [
        "create",
        "--title", title,
        "--type", "task",
        "--labels", REVIEW_LABEL,
        "--no-inherit-labels",
        "--parent", args.itemId,
        "-d", args.summary,
        "--acceptance", "Accepted from the breakdown board",
        "--json",
      ],
      bdCwd,
    );
    if (created.code !== 0) {
      throw new Refusal(`bd create failed in ${project.path}: ${firstLine(created)}. Nothing was filed.`);
    }
    try {
      const parsedCreate = parseJsonOutput(created.stdout);
      review = Array.isArray(parsedCreate) ? parsedCreate[0] : parsedCreate;
      if (typeof review?.id !== "string") throw new Error("no id");
    } catch {
      throw new Refusal(
        `bd create ran but printed no issue id; check \`bd list --parent ${args.itemId} --label review\` in ${project.path} before retrying.`,
      );
    }
  }
  const id = review.id;
  const partial = (step, detail) => {
    deps.warn(
      `${PREFIX}review ${id} was filed but ${step} failed: ${detail}. Re-run the same command to retry; it reuses ${id}.`,
    );
    return { exitCode: 1 };
  };

  if (!SAFE_SEGMENT.test(id)) {
    return partial("moving images into place", `issue id ${JSON.stringify(id)} is not a directory name`);
  }
  let stored;
  try {
    stored = await placeImages(deps, project.key, id, staged);
  } catch (err) {
    return partial("moving images into place", err.message);
  }

  const metadata = reviewMetadata({ images: stored, pane, socket, summary: args.summary });
  const updateArgs = ["update", id, "--metadata", JSON.stringify(metadata)];
  if (existing) updateArgs.push("--description", args.summary);
  if (existing && (review.labels ?? []).includes(CHANGES_LABEL)) updateArgs.push("--remove-label", CHANGES_LABEL);
  const updated = await deps.run("bd", updateArgs, bdCwd);
  if (updated.code !== 0) return partial("bd update", firstLine(updated));

  if (existing && hadImages(review)) {
    const commented = await deps.run("bd", ["comments", "add", id, `Review updated: ${args.summary}`], bdCwd);
    if (commented.code !== 0) return partial("bd comments add", firstLine(commented));
  }

  // bd forbids task↔epic `blocks`; an epic is gated by the parent link alone.
  if (item.issue_type !== "epic" && !blocksOn(item, id)) {
    const dep = await deps.run("bd", ["dep", "add", args.itemId, id, "--type", "blocks"], bdCwd);
    if (dep.code !== 0) return partial("bd dep add", firstLine(dep));
  }

  const link = boardLink(args.boardUrl, project.key, id);
  await showInChrome(deps, args.boardUrl, link);

  const notified = await deps.run(
    "herdr",
    [
      "notification", "show", `Review requested: ${project.key} ${args.itemId}`,
      "--body", args.summary.slice(0, MAX_NOTIFICATION_BODY),
      "--sound", "request",
    ],
    { cwd: deps.cwd },
  );
  if (notified.code !== 0) deps.warn(`${PREFIX}herdr notification failed (${firstLine(notified)}).`);

  if (pane === null) {
    deps.warn(
      `${PREFIX}HERDR_PANE_ID is not set to a pane id, so the decision cannot be pushed to this pane; read \`bd comments ${id}\` for it.`,
    );
  } else if (socket === null) {
    deps.warn(
      `${PREFIX}HERDR_SOCKET_PATH is not set to an absolute socket path, so the decision cannot be pushed to this pane; read \`bd comments ${id}\` for it.`,
    );
  }

  const count = `${stored.length} image${stored.length === 1 ? "" : "s"}`;
  deps.out(`Review ${id} ${existing ? "updated" : "filed"} for ${args.itemId} in ${project.key} (${count}).`);
  deps.out(`Board: ${link}`);
  deps.out(
    `End your turn now and wait for a prompt in this pane with the decision (Review ${id} accepted|changes requested: …). If none arrives, read \`bd comments ${id}\`.`,
  );
  return { exitCode: 0 };
}
