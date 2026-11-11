// review-request: files or refreshes a review bead for an item and points the
// breakdown board at it. Plain Node ESM so it runs from any checkout without
// the workspace toolchain (design decision 7 of
// openspec/changes/board-visual-reviews). Every external effect — git, bd,
// open, herdr, fetch — is injected so the flow is testable without them.
//
// Two forms (decision-card-reviews, design.md decision 4). The image form,
// `<item-id> --summary <text> <image>...`, has no dependencies at all. The
// card form, `<item-id> <card.md>`, reads one markdown file — YAML
// frontmatter holding a decision card, a body holding the evidence — and is
// the only path that loads the `yaml` package, through a dynamic import, so
// the image form keeps working in a checkout that has not run `pnpm install`
// since the package was added. The card validator mirrors
// `normalizeReviewMetadata` in packages/core/src/reviews.ts strictly: where
// the normalizer fits over-long text, this refuses it naming the field, so
// every card it accepts normalizes to itself (fixtures/review-cards/).
//
// Several cards (split-review-decisions, design.md decisions 1-3):
// `<item-id> a.md b.md ...` files one review per card under the item. Every
// card is validated and every image staged before any bead is written; the
// notification, the board link, and the closing lines cover the call once.
// A card's review is found again by its key (frontmatter `key`, else the
// filename stem slugged), recorded in `review.key`. With no review holding
// the key, a single card (and the image form, which writes no key) reuses
// the newest keyless open review, as before keys existed; a multi-card call
// never takes a keyless review, it warns about it.

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

export const USAGE = [
  "usage: review-request <item-id> <card.md>... [--board-url <url>]",
  "       review-request <item-id> --summary <text> [--board-url <url>] <image>...",
  "",
  "One decision per card. Several decisions are several cards in one call, each answered on its own.",
  "Text, tables, and code go in the card (its body, a diff, a mermaid diagram), never in an image;",
  "images are for what must be seen. A re-run replaces the review with the same key: keep a card's",
  "filename across revisions, or set `key:` in its frontmatter.",
].join("\n");
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
/** Cards one call may file. */
export const MAX_CARDS = 6;
// Must agree with REVIEW_KEY_PATTERN in packages/core/src/reviews.ts.
const REVIEW_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_NOTIFICATION_BODY = 200;
const REVIEW_LABEL = "review";
const CHANGES_LABEL = "review:changes";
/** Every review bead's acceptance criteria (bead convention). The board strips the section the beads mapper builds from it off a card's evidence (apps/web/src/lib/reviewCard.ts, REVIEW_ACCEPTANCE). */
export const REVIEW_ACCEPTANCE = "Accepted from the breakdown board";
const OPEN_STATUSES = "open,in_progress,blocked,deferred";

// The card contract; each limit must agree with its namesake in
// packages/core/src/reviews.ts (MAX_REVIEW_QUESTION_LENGTH and the rest).
const CARD_KEYS = ["question", "options", "recommend", "on_accept", "attachments", "key"];
const OPTION_KEYS = ["id", "label", "what", "risk"];
const ATTACHMENT_KEYS = {
  image: ["kind", "path", "caption", "pair"],
  mermaid: ["kind", "source", "caption", "pair"],
  diff: ["kind", "source", "caption", "pair"],
};
const ATTACHMENT_PAIRS = ["before", "after"];
const MAX_QUESTION = 140;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
const MAX_OPTION_LABEL = 80;
const MAX_OPTION_TEXT = 300;
const MAX_ON_ACCEPT_STEPS = 8;
const MAX_ON_ACCEPT_STEP = 200;
const MAX_ATTACHMENTS = 20;
const MAX_CAPTION = 200;
const MAX_SOURCE = 8000;
/** MAX_REVIEW_METADATA_CHARS: over it, the board reads the review as invalid. */
const MAX_REVIEW_JSON = 16_000;
const MAX_BODY = 8000;
// Reading time, not storage (design.md decision 8): words outside fenced blocks. CLI only; the normalizer never sees the body.
export const MAX_BODY_WORDS = 300;
// A legacy summary longer than two questions' worth (2 × 140) is filed, then warned about (design.md decision 8).
export const SUMMARY_WARN_CHARS = 280;
/** A card file over this many bytes is refused before it is read; a card at every limit is well under it. */
const MAX_CARD_FILE_BYTES = 64 * 1024;
const MAX_ECHO = 60;
// A new review's id is not known until bd creates it; bd names a child
// `<parent>.<n>`, and the size check assumes n has at most this many digits.
const NEW_REVIEW_ID_SUFFIX = `.${"9".repeat(15)}`;

/**
 * @returns {{ help: true } | { error: string }
 *   | { args: { itemId: string, summary: string, boardUrl: string, images: string[] } }
 *   | { args: { itemId: string, cardPaths: string[], boardUrl: string } }}
 */
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
  if (values.summary === undefined && images.length > 0 && images.every((p) => p.endsWith(".md"))) {
    if (images.length > MAX_CARDS) return { error: `at most ${MAX_CARDS} cards in one call, got ${images.length}` };
    const boardUrl = values["board-url"] ?? DEFAULT_BOARD_URL;
    if (!isHttpUrl(boardUrl)) return { error: `--board-url must be an http(s) URL: ${boardUrl}` };
    return { args: { itemId, cardPaths: images, boardUrl } };
  }
  if (values.summary === undefined && images.some((p) => p.endsWith(".md"))) {
    return { error: "card files and images can't be mixed: images go in a card's attachments" };
  }
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

/**
 * A card file split at its frontmatter: a first line `---`, then the YAML up
 * to the next line that is exactly `---` (a block scalar's lines are
 * indented, so a diff's `--- a/x` inside one never ends it). Null when the
 * file does not start with frontmatter. A leading BOM is dropped, CRLF line
 * ends become LF, and the body is trimmed. The frontmatter starts on the
 * file's second line, so its line n is the file's line n + 1.
 */
export function splitCard(text) {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split("\n").map((line) => line.replace(/\r$/, ""));
  const isFence = (line) => line.trimEnd() === "---";
  if (!isFence(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && isFence(line));
  if (end === -1) return null;
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n").trim() };
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A value echoed in a refusal: its kind for a container, else its JSON cut to MAX_ECHO characters. */
function describe(value) {
  if (Array.isArray(value)) return "a list";
  if (isPlainObject(value)) return "a mapping";
  if (typeof value === "object" && value !== null) return `a ${value.constructor?.name ?? "object"}`;
  const text = JSON.stringify(value) ?? String(value);
  if (text.length <= MAX_ECHO) return text;
  const last = text.charCodeAt(MAX_ECHO - 2);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_ECHO - 2 : MAX_ECHO - 1)}…`;
}

/**
 * Text the store can hold: no NUL (Postgres jsonb refuses it) and no unpaired
 * surrogate (nor is that valid Unicode; one bad review would fail a tracker's
 * whole load). The problem, or null.
 */
function textProblem(field, text) {
  if (text.includes("\u0000")) return `${field}: contains a NUL character`;
  if (!text.isWellFormed()) return `${field}: contains an unpaired surrogate (not valid Unicode)`;
  return null;
}

/** An id YAML read as a number, which a person meant as text. */
function numericIdProblem(field, key, value) {
  return typeof value === "number" ? `${field}: got the number ${value}; quote it: ${key}: "${value}"` : null;
}

/**
 * A card text field, strictly: a string, trimmed, no NUL, within `max`
 * (UTF-16 units, as fitText measures). A missing or blank optional field is
 * left out, as the normalizer leaves it out; a required one is refused.
 * @returns {string | undefined}
 */
function cardText(problems, field, value, max, required) {
  if (value === undefined || value === null) {
    if (required) problems.push(`${field}: required`);
    return undefined;
  }
  if (typeof value !== "string") {
    problems.push(`${field}: must be text, got ${describe(value)}`);
    return undefined;
  }
  const bad = textProblem(field, value);
  if (bad) {
    problems.push(bad);
    return undefined;
  }
  const text = value.trim();
  if (text === "") {
    if (required) problems.push(`${field}: required, got blank text`);
    return undefined;
  }
  if (text.length > max) {
    problems.push(`${field}: at most ${max} characters, got ${text.length}`);
    return undefined;
  }
  return text;
}

function unknownKeys(problems, prefix, value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${prefix}${key}: not a field of ${what} (fields: ${allowed.join(", ")})`);
  }
}

function validateOptions(problems, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    problems.push(`options: must be a list of ${MIN_OPTIONS} to ${MAX_OPTIONS} options, got ${describe(raw)}`);
    return undefined;
  }
  if (raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    problems.push(`options: ${MIN_OPTIONS} to ${MAX_OPTIONS} options, got ${raw.length}`);
    return undefined;
  }
  const before = problems.length;
  const options = [];
  const seen = new Map();
  for (const [index, option] of raw.entries()) {
    const field = `options[${index}]`;
    if (!isPlainObject(option)) {
      problems.push(`${field}: must be a mapping with id and label, got ${describe(option)}`);
      continue;
    }
    unknownKeys(problems, `${field}.`, option, OPTION_KEYS, "an option");
    const id = option.id;
    const numeric = numericIdProblem(`${field}.id`, "id", id);
    if (numeric) {
      problems.push(numeric);
    } else if (typeof id !== "string" || !OPTION_ID.test(id)) {
      problems.push(
        `${field}.id: must be a letter or digit, then up to 15 letters, digits, _ or -; got ${id === undefined ? "nothing" : describe(id)}`,
      );
    } else if (seen.has(id)) {
      problems.push(`${field}.id: ${id} repeats options[${seen.get(id)}].id`);
    } else {
      seen.set(id, index);
    }
    const label = cardText(problems, `${field}.label`, option.label, MAX_OPTION_LABEL, true);
    const what = cardText(problems, `${field}.what`, option.what, MAX_OPTION_TEXT, false);
    const risk = cardText(problems, `${field}.risk`, option.risk, MAX_OPTION_TEXT, false);
    options.push({ id, label, ...(what === undefined ? {} : { what }), ...(risk === undefined ? {} : { risk }) });
  }
  return problems.length === before ? options : undefined;
}

function validateOnAccept(problems, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    problems.push(`on_accept: must be a list of at most ${MAX_ON_ACCEPT_STEPS} steps, got ${describe(raw)}`);
    return undefined;
  }
  if (raw.length > MAX_ON_ACCEPT_STEPS) {
    problems.push(`on_accept: at most ${MAX_ON_ACCEPT_STEPS} steps, got ${raw.length}`);
    return undefined;
  }
  const steps = raw.map((step, index) => cardText(problems, `on_accept[${index}]`, step, MAX_ON_ACCEPT_STEP, true));
  return steps.length > 0 && steps.every((step) => step !== undefined) ? steps : undefined;
}

/** @returns {Promise<{ attachments: object[] | undefined, imagePaths: string[] }>} image paths absolute, in attachment order. */
async function validateAttachments(problems, raw, cardDir) {
  const none = { attachments: undefined, imagePaths: [] };
  if (raw === undefined || raw === null) return none;
  if (!Array.isArray(raw)) {
    problems.push(`attachments: must be a list of at most ${MAX_ATTACHMENTS} attachments, got ${describe(raw)}`);
    return none;
  }
  if (raw.length > MAX_ATTACHMENTS) {
    problems.push(`attachments: at most ${MAX_ATTACHMENTS} attachments, got ${raw.length}`);
    return none;
  }
  const before = problems.length;
  const attachments = [];
  const imagePaths = [];
  for (const [index, attachment] of raw.entries()) {
    const field = `attachments[${index}]`;
    if (!isPlainObject(attachment)) {
      problems.push(`${field}: must be a mapping with a kind, got ${describe(attachment)}`);
      continue;
    }
    const kind = attachment.kind;
    if (!Object.hasOwn(ATTACHMENT_KEYS, kind)) {
      problems.push(`${field}.kind: must be image, mermaid, or diff, got ${kind === undefined ? "nothing" : describe(kind)}`);
      continue;
    }
    unknownKeys(problems, `${field}.`, attachment, ATTACHMENT_KEYS[kind], `${kind === "image" ? "an" : "a"} ${kind} attachment`);
    const caption = cardText(problems, `${field}.caption`, attachment.caption, MAX_CAPTION, false);
    const pair = attachment.pair;
    if (pair !== undefined && pair !== null && !ATTACHMENT_PAIRS.includes(pair)) {
      problems.push(`${field}.pair: must be before or after, got ${describe(pair)}`);
    }
    const extras = { ...(caption === undefined ? {} : { caption }), ...(pair === undefined || pair === null ? {} : { pair }) };
    if (kind === "image") {
      const given = attachment.path;
      if (typeof given !== "string" || given.trim() === "" || given.includes("\u0000")) {
        problems.push(`${field}.path: must be the path of an image, relative to the card, got ${given === undefined ? "nothing" : describe(given)}`);
        continue;
      }
      const abs = path.resolve(cardDir, given);
      const problem = imageProblem(given, await statOrNull(abs));
      if (problem) problems.push(`${field}.path: ${problem}`);
      imagePaths.push(abs);
      // The stored path replaces this one once the image is staged (cardReview).
      attachments.push({ kind, path: abs, ...extras });
    } else {
      const source = attachment.source;
      if (typeof source !== "string" || source.trim() === "") {
        problems.push(`${field}.source: required text, got ${source === undefined ? "nothing" : describe(source)}`);
      } else if (textProblem(`${field}.source`, source)) {
        problems.push(textProblem(`${field}.source`, source));
      } else if (source.length > MAX_SOURCE) {
        problems.push(`${field}.source: at most ${MAX_SOURCE} characters, got ${source.length}`);
      }
      attachments.push({ kind, source, ...extras });
    }
  }
  if (problems.length > before) return none;
  return { attachments: attachments.length > 0 ? attachments : undefined, imagePaths };
}

// A fence opener after its indent: three or more backticks or tildes; a backtick fence's info string holds no backtick.
const FENCE_OPEN = /^(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
// Blockquote markers, each with up to three spaces before it and one optional space after.
const BLOCKQUOTE = /^(?: {0,3}> ?)+/;
// A list item's marker and the spaces after it; the item's content starts after them.
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const ORDERED_MARKER = /^\d{1,9}[.)]$/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * The words a reviewer reads in a card body (design.md decision 8): every
 * whitespace-separated token holding a letter or digit, outside fenced code
 * blocks, except an ordered-list marker (`1.`, `2)`) opening a line. Table
 * pipes, separator rows, bullets, and lone punctuation are free; table cells
 * and inline code count.
 *
 * Blockquote markers are stripped from each line first, so a fence inside a
 * blockquote is a fence. A line is a fence opener when, after its indent,
 * it starts with three or more backticks (an info string with no backtick)
 * or tildes, and the indent is at most three spaces, or at most three
 * spaces past the content column of the list item it sits under; a fence
 * may also open right after a list marker (`- ```js`). That list
 * item is the most recent one; a non-blank line after a blank line, indented
 * less than its content column and not itself a list item, ends it. The
 * fence closes on a line of the same character, at least as long, with
 * nothing after it and indented at most three spaces past the opener's
 * container; an unclosed fence runs to the end of the body (CommonMark would
 * also end it with its list item or blockquote; this does not).
 *
 * Everything else is text, so it counts: an indented code block (four or
 * more spaces with no list item to account for them) is read, and the spec
 * exempts only fenced blocks.
 */
export function countBodyWords(body) {
  let words = 0;
  let fence = null;
  let listContent = null;
  let previousBlank = false;
  for (const raw of body.split(/\r\n|\n|\r/)) {
    const line = raw.replace(BLOCKQUOTE, "");
    const indent = line.length - line.trimStart().length;
    const rest = line.slice(indent);
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(rest);
      if (close && indent <= fence.base + 3 && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
      continue;
    }
    const blank = rest === "";
    const item = LIST_ITEM.exec(line);
    if (item) {
      // CommonMark: five or more spaces after the marker make it one space plus an indented code block.
      const gap = item[3].length >= 5 || item[3] === "" ? 1 : item[3].length;
      listContent = item[1].length + item[2].length + gap;
    } else if (!blank && previousBlank && listContent !== null && indent < listContent) {
      listContent = null;
    }
    previousBlank = blank;
    // A fence may open on the item's own line (`- ```js`), or on a line of its own.
    const base = item ? listContent : indent <= 3 ? 0 : listContent !== null && indent >= listContent && indent - listContent <= 3 ? listContent : null;
    const open = base === null ? null : FENCE_OPEN.exec(item ? line.slice(item[0].length) : rest);
    if (open) {
      fence = { marker: open[1], base };
      continue;
    }
    const tokens = rest.split(/\s+/);
    if (item && ORDERED_MARKER.test(tokens[0])) tokens.shift();
    for (const token of tokens) if (WORD.test(token)) words += 1;
  }
  return words;
}

/**
 * A parsed frontmatter value and body checked against the card contract,
 * every problem collected and named by its field. The card comes back in
 * the normalizer's key order, with image paths absolute (resolved against
 * `cardDir`); `problems` is empty when it may be filed.
 */
export async function validateCard(raw, body, cardDir) {
  const problems = [];
  if (!isPlainObject(raw)) {
    return { problems: [`frontmatter: must be a mapping of card fields, got ${describe(raw)}`], card: null, imagePaths: [] };
  }
  for (const key of Object.keys(raw)) {
    if (!CARD_KEYS.includes(key)) problems.push(`${key}: unknown field (card fields: ${CARD_KEYS.join(", ")})`);
  }
  const question = cardText(problems, "question", raw.question, MAX_QUESTION, true);
  // The question is the headline: the summary, the notification, the update comment.
  if (question !== undefined && /[\r\n\u2028\u2029]/.test(question)) problems.push("question: must be one line");
  const options = validateOptions(problems, raw.options);
  const recommend = raw.recommend;
  if (recommend !== undefined && recommend !== null) {
    if (raw.options === undefined || raw.options === null) {
      problems.push("recommend: allowed only with options");
    } else if (numericIdProblem("recommend", "recommend", recommend)) {
      problems.push(numericIdProblem("recommend", "recommend", recommend));
    } else if (typeof recommend !== "string") {
      problems.push(`recommend: must be an option id, got ${describe(recommend)}`);
    } else if (options !== undefined && !options.some((option) => option.id === recommend)) {
      problems.push(`recommend: ${JSON.stringify(recommend)} names no option (options: ${options.map((o) => o.id).join(", ")})`);
    }
  }
  const onAccept = validateOnAccept(problems, raw.on_accept);
  const key = validateKey(problems, raw.key);
  const { attachments, imagePaths } = await validateAttachments(problems, raw.attachments, cardDir);
  const bodyProblem = textProblem("body", body);
  if (bodyProblem) problems.push(bodyProblem);
  else if (body.length > MAX_BODY) problems.push(`body: at most ${MAX_BODY} characters, got ${body.length}`);
  else {
    const words = countBodyWords(body);
    if (words > MAX_BODY_WORDS) problems.push(`body: at most ${MAX_BODY_WORDS} words outside fenced blocks, got ${words}`);
  }
  if (problems.length > 0) return { problems, card: null, imagePaths: [], key: undefined };
  const card = {
    question,
    ...(options === undefined ? {} : { options }),
    ...(recommend === undefined || recommend === null ? {} : { recommend }),
    ...(onAccept === undefined ? {} : { on_accept: onAccept }),
    ...(attachments === undefined ? {} : { attachments }),
  };
  return { problems, card, imagePaths, key };
}

const KEY_RULE = "a lower-case letter or digit, then up to 39 lower-case letters, digits, _ or -";

/** A frontmatter `key`, validated as given (never slugged, so the agent sees exactly what it set); undefined when absent. */
function validateKey(problems, raw) {
  if (raw === undefined || raw === null) return undefined;
  const numeric = numericIdProblem("key", "key", raw);
  if (numeric) {
    problems.push(numeric);
    return undefined;
  }
  if (typeof raw !== "string" || !REVIEW_KEY.test(raw)) {
    problems.push(`key: must be ${KEY_RULE}; got ${describe(raw)}`);
    return undefined;
  }
  return raw;
}

/** A card's key from its filename when its frontmatter sets none: the stem lower-cased, each run of other characters a `-`, outer `-` dropped. Null when that leaves no valid key. */
export function keyFromFilename(cardPath) {
  const stem = path.basename(cardPath).replace(/\.md$/, "");
  const key = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return REVIEW_KEY.test(key) ? key : null;
}

/**
 * The `review` value the card form writes: the legacy keys (`summary` = the
 * question, `images` = the stored image paths) and then the card, each image
 * attachment's path replaced by its stored path, in order.
 */
export function cardReview({ card, images, pane, socket = null, key = undefined }) {
  let next = 0;
  const attachments = card.attachments?.map((attachment) =>
    attachment.kind === "image" ? { ...attachment, path: images[next++] } : attachment,
  );
  return {
    ...reviewMetadata({ images, pane, socket, summary: card.question }).review,
    ...(key === undefined ? {} : { key }),
    ...card,
    ...(attachments === undefined ? {} : { attachments }),
  };
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

/** The key an open review child records, or null for a keyless one (every review filed before keys, and every image-form review). */
export function reviewKeyOf(child) {
  const key = child?.metadata?.review?.key;
  return typeof key === "string" && key !== "" ? key : null;
}

/**
 * The open review child a request reuses (design.md decision 3): the newest
 * holding `key`; else, for a single card or the image form (`key` null), the
 * newest keyless one; else null. Older duplicates are left alone; `count` is
 * how many matched.
 */
export function chooseReview(children, key = null, { single = true } = {}) {
  const time = (child) => {
    const parsed = Date.parse(child.created_at);
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  const newest = (list) => (list.length === 0 ? null : { review: [...list].sort((a, b) => time(b) - time(a))[0], count: list.length });
  if (key !== null) {
    const keyed = newest(children.filter((child) => reviewKeyOf(child) === key));
    if (keyed !== null || !single) return keyed;
  }
  return newest(children.filter((child) => reviewKeyOf(child) === null));
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

// An open app tab is left alone, not navigated or raised: whatever view it
// shows (graph, feed, board), the review queue picks the new review up live,
// and the herdr notification tells the person it is there. A second tab
// would also hold another live-update stream, and Chrome allows six HTTP/1.1
// connections per host. The script only probes whether any Chrome tab is
// under the app's base URL and prints `present` or `none`. Every tab's URL
// comes back in one Apple event, so many tabs cost one round trip and a tab
// closing mid-scan cannot fail the probe. It never launches Chrome (a `tell`
// would), and the prefix arrives as argv, never interpolated into the script
// text. Any other answer, or a failed run, warns and opens a tab.
export const CHROME_APP_TAB_SCRIPT = `on run argv
  set appPrefix to item 1 of argv
  if application "Google Chrome" is not running then return "none"
  tell application "Google Chrome" to set urlsByWindow to URL of every tab of every window
  repeat with windowUrls in urlsByWindow
    repeat with tabUrl in windowUrls
      if (tabUrl as text) starts with appPrefix then return "present"
    end repeat
  end repeat
  return "none"
end run`;

/** @returns {Promise<boolean>} true when an open app tab will show the review, so no tab was opened. */
async function showInChrome(deps, boardUrl, link) {
  // The trailing slash keeps http://localhost:5310 from matching :53100.
  const appPrefix = `${boardUrl.replace(/\/+$/, "")}/`;
  const probed = await deps.run("osascript", ["-e", CHROME_APP_TAB_SCRIPT, appPrefix], { cwd: deps.cwd });
  const answer = probed.code === 0 ? probed.stdout.trim() : null;
  if (answer === "present") return true;
  if (answer !== "none") {
    const why = probed.code === 0 ? `unexpected output ${JSON.stringify(answer)}` : firstLine(probed);
    deps.warn(`${PREFIX}could not tell whether an app tab is open (${why}); opening a new one.`);
  }
  const opened = await deps.run("open", ["-a", "Google Chrome", link], { cwd: deps.cwd });
  if (opened.code !== 0) deps.warn(`${PREFIX}could not open Chrome (${firstLine(opened)}); open ${link} yourself.`);
  return false;
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
  const stagedAll = [];
  try {
    const requests = "cardPaths" in parsed.args ? await readCardRequests(deps, parsed.args) : [await imageRequest(deps, parsed.args)];
    const plan = await check(deps, requests[0]);
    const single = requests.length === 1;
    const chosen = requests.map((request) => chooseReview(plan.children, request.card ? request.key : null, { single }));
    for (const [index, request] of requests.entries()) {
      if (request.card) checkCardSize(deps, request, { project: plan.project, existing: chosen[index] });
    }
    for (const request of requests) stagedAll.push(await stageImages(deps, plan.project.key, request.images));
    const result = await fileAll(deps, requests, plan, chosen, stagedAll);
    if (result.exitCode === 0 && "summary" in parsed.args) {
      const warning = summaryWarning(parsed.args, deps.breakdownRoot);
      if (warning) deps.warn(warning);
    }
    return result;
  } catch (err) {
    const message = err instanceof Refusal ? err.message : `unexpected error: ${err?.message ?? String(err)}`;
    for (const line of message.split("\n")) deps.warn(PREFIX + line);
    return { exitCode: 1 };
  } finally {
    // Already gone once the images were moved into place; on any other path nothing may be left behind.
    for (const staged of stagedAll) await fs.rm(staged.dir, { recursive: true, force: true });
  }
}

/**
 * The image form's one warning, printed after a successful filing (design.md
 * decision 8): a summary over SUMMARY_WARN_CHARS is a decision written as a
 * paragraph. Null when the summary is within it. Never a refusal.
 */
export function summaryWarning({ itemId, summary }, breakdownRoot) {
  if (summary.length <= SUMMARY_WARN_CHARS) return null;
  return `${PREFIX}warning: the summary is ${summary.length} characters, over ${SUMMARY_WARN_CHARS}; a decision reads faster as a card, one card per decision: review-request ${itemId} <card.md>... (examples: ${path.join(breakdownRoot, "fixtures", "review-cards")}).`;
}

/**
 * What `write` files, from either form: `images` as given (resolved against
 * the cwd when staged), `description` for the bead, `headline` for the
 * notification and the update comment, and the validated card or null.
 */
async function imageRequest(deps, args) {
  const problems = [];
  for (const given of args.images) {
    const problem = imageProblem(given, await statOrNull(path.resolve(deps.cwd, given)));
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) throw new Refusal([...problems, "Nothing was filed."].join("\n"));
  const { itemId, boardUrl, images, summary } = args;
  return { itemId, boardUrl, images, description: summary, headline: summary, card: null };
}

async function readCardRequest(deps, args) {
  const cardFile = path.resolve(deps.cwd, args.cardPath);
  const refuseFile = (why) => new Refusal(`card ${args.cardPath}: ${why}. Nothing was filed.`);
  let text;
  try {
    const stat = await statOrNull(cardFile);
    if (stat === null) throw refuseFile("not found");
    if (!stat.isFile()) throw refuseFile("not a regular file");
    if (stat.size > MAX_CARD_FILE_BYTES) throw refuseFile(`${stat.size} bytes, over the ${MAX_CARD_FILE_BYTES}-byte limit`);
    text = await fs.readFile(cardFile, "utf8");
  } catch (err) {
    throw err instanceof Refusal ? err : refuseFile(err.message);
  }
  const split = splitCard(text);
  if (split === null) {
    throw new Refusal(
      `frontmatter: missing in ${args.cardPath}; a card starts with a \`---\` line, the card's YAML, and another \`---\` line. Nothing was filed.`,
    );
  }
  let YAML;
  try {
    YAML = await (deps.importYaml ?? (() => import("yaml")))();
  } catch (err) {
    throw new Refusal(
      `the card form needs the yaml package, which did not load (${firstLineOf(err?.message ?? String(err))}): run pnpm install in ${deps.breakdownRoot}. Nothing was filed.`,
    );
  }
  let raw;
  try {
    raw = YAML.parse(split.frontmatter) ?? {};
  } catch (err) {
    // The parser counts lines from the frontmatter's first; the file's is one above it (splitCard).
    const where = firstLineOf(err?.message ?? String(err)).replace(
      / at line (\d+), column (\d+)$/,
      (_, line, column) => ` at line ${Number(line) + 1}, column ${column} of ${args.cardPath}`,
    );
    throw new Refusal(`frontmatter: not valid YAML: ${where}. Nothing was filed.`);
  }
  const { problems, card, imagePaths, key: given } = await validateCard(raw, split.body, path.dirname(cardFile));
  const key = given ?? keyFromFilename(args.cardPath);
  if (problems.length === 0 && key === null) {
    problems.push(`key: the filename ${path.basename(args.cardPath)} gives no usable key; set one in the frontmatter (${KEY_RULE})`);
  }
  if (problems.some((problem) => OVER_BUDGET.test(problem))) problems.push(splitHint(args.itemId));
  if (problems.length > 0) throw new Refusal([...problems, "Nothing was filed."].join("\n"));
  return {
    itemId: args.itemId,
    boardUrl: args.boardUrl,
    cardPath: args.cardPath,
    images: imagePaths,
    description: split.body === "" ? card.question : split.body,
    headline: card.question,
    card,
    key,
  };
}

/** A refusal for a card holding more than one decision fits: the question's length, or the body's characters or words. */
const OVER_BUDGET = /^(question|body): at most /;

export function splitHint(itemId) {
  return `several decisions? one card each: review-request ${itemId} a.md b.md …`;
}

/**
 * Every card of the call read and validated before anything else (design.md
 * decision 1). One card refuses exactly as it always has; with several, each
 * problem is prefixed with its card, keys must be unique, and the call
 * refuses once with every card's problems.
 */
async function readCardRequests(deps, args) {
  const read = (cardPath) => readCardRequest(deps, { itemId: args.itemId, boardUrl: args.boardUrl, cardPath });
  if (args.cardPaths.length === 1) return [await read(args.cardPaths[0])];
  const requests = [];
  const problems = [];
  for (const cardPath of args.cardPaths) {
    try {
      requests.push(await read(cardPath));
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      for (const line of err.message.split("\n")) {
        const text = line.replace(/\s*Nothing was filed\.$/, "");
        if (text !== "" && !text.startsWith("several decisions?")) problems.push(`${cardPath}: ${text}`);
      }
    }
  }
  const byKey = new Map();
  for (const request of requests) byKey.set(request.key, [...(byKey.get(request.key) ?? []), request.cardPath]);
  for (const [key, paths] of byKey) {
    if (paths.length > 1) problems.push(`key ${key}: set by ${paths.join(" and ")}; each card needs its own key`);
  }
  if (problems.some((problem) => / (question|body): at most /.test(problem))) problems.push(splitHint(args.itemId));
  if (problems.length > 0) throw new Refusal([...problems, "Nothing was filed."].join("\n"));
  return requests;
}

function firstLineOf(text) {
  return text.split("\n")[0].replace(/[:.]\s*$/, "");
}

/**
 * Refuses, before any write, a card whose review would be over the board's
 * JSON cap. Stored paths are predicted: a reused review's id is known; a new
 * one is assumed to be `<item>.<n>` with n of at most 15 digits.
 */
function checkCardSize(deps, request, { project, existing }) {
  const id = existing ? existing.review.id : `${request.itemId}${NEW_REVIEW_ID_SUFFIX}`;
  const dir = path.join(reviewDir(deps.homedir, project.key), id);
  const images = request.images.map((given, index) => path.join(dir, copiedName(index, given)));
  const review = cardReview({ card: request.card, images, pane: paneFrom(deps.env), socket: socketFrom(deps.env), key: request.key });
  // The normalizer writes `pane: null` when there is none; count it as it will be stored.
  const size = JSON.stringify({ pane: null, ...review }).length;
  if (size > MAX_REVIEW_JSON) {
    throw new Refusal(
      `card: the review would be ${size} characters of JSON, over the board's limit of ${MAX_REVIEW_JSON}; shorten attachment sources or move that evidence into the body. Nothing was filed.`,
    );
  }
}

/** Everything else that can refuse runs here, before any write. */
async function check(deps, args) {
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
  return { project, item, children, bdCwd };
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

/**
 * A reused bead with images or a question on record finished a request
 * before; one without is a retry of a failed first request. (A card may have
 * no images, so its question is the mark.)
 */
function finishedBefore(review) {
  const recorded = review.metadata?.review;
  return (Array.isArray(recorded?.images) && recorded.images.length > 0) || typeof recorded?.question === "string";
}

/** `Review: <text>` within MAX_TITLE characters, never splitting a surrogate pair. */
function reviewTitle(text, cut) {
  if (!cut) return `Review: ${text}`;
  const full = `Review: ${text}`;
  if (full.length <= MAX_TITLE) return full;
  const last = full.charCodeAt(MAX_TITLE - 1);
  return full.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_TITLE - 1 : MAX_TITLE);
}

/**
 * Files or reuses one request's review: create (or reuse), images into
 * place, metadata, the update comment, the blocking edge. `{ ok: true, id,
 * reused, stored }`, or `{ ok: false, id, message, filedNothing }` naming the
 * step that failed (id null when no bead exists for it).
 */
async function fileOne(deps, request, { project, item, bdCwd }, existing, staged, { pane, socket }) {
  // A card review is titled with its question (design.md decision 4); the image form keeps the item's title.
  const title = request.card ? reviewTitle(request.card.question, true) : `Review: ${String(item.title ?? request.itemId).slice(0, MAX_TITLE)}`;
  let review;
  if (existing) {
    review = existing.review;
  } else {
    const created = await deps.run(
      "bd",
      [
        "create",
        "--title", title,
        "--type", "task",
        "--labels", REVIEW_LABEL,
        "--no-inherit-labels",
        "--parent", request.itemId,
        "-d", request.description,
        "--acceptance", REVIEW_ACCEPTANCE,
        "--json",
      ],
      bdCwd,
    );
    if (created.code !== 0) {
      return { ok: false, id: null, filedNothing: true, message: `bd create failed in ${project.path}: ${firstLine(created)}.` };
    }
    try {
      const parsedCreate = parseJsonOutput(created.stdout);
      review = Array.isArray(parsedCreate) ? parsedCreate[0] : parsedCreate;
      if (typeof review?.id !== "string") throw new Error("no id");
    } catch {
      return {
        ok: false,
        id: null,
        filedNothing: false,
        message: `bd create ran but printed no issue id; check \`bd list --parent ${request.itemId} --label review\` in ${project.path} before retrying.`,
      };
    }
  }
  const id = review.id;
  const partial = (step, detail) => ({ ok: false, id, filedNothing: false, message: `review ${id} was filed but ${step} failed: ${detail}.` });

  if (!SAFE_SEGMENT.test(id)) return partial("moving images into place", `issue id ${JSON.stringify(id)} is not a directory name`);
  let stored;
  try {
    stored = await placeImages(deps, project.key, id, staged);
  } catch (err) {
    return partial("moving images into place", err.message);
  }

  const metadata = request.card
    ? { review: cardReview({ card: request.card, images: stored, pane, socket, key: request.key }) }
    : reviewMetadata({ images: stored, pane, socket, summary: request.headline });
  const updateArgs = ["update", id, "--metadata", JSON.stringify(metadata)];
  if (existing) updateArgs.push("--description", request.description);
  if (existing && (review.labels ?? []).includes(CHANGES_LABEL)) updateArgs.push("--remove-label", CHANGES_LABEL);
  if (existing && request.card && review.title !== title) updateArgs.push("--title", title);
  const updated = await deps.run("bd", updateArgs, bdCwd);
  if (updated.code !== 0) return partial("bd update", firstLine(updated));

  if (existing && finishedBefore(review)) {
    const commented = await deps.run("bd", ["comments", "add", id, `Review updated: ${request.headline}`], bdCwd);
    if (commented.code !== 0) return partial("bd comments add", firstLine(commented));
  }

  // bd forbids task↔epic `blocks`; an epic is gated by the parent link alone.
  if (item.issue_type !== "epic" && !blocksOn(item, id)) {
    const dep = await deps.run("bd", ["dep", "add", request.itemId, id, "--type", "blocks"], bdCwd);
    if (dep.code !== 0) return partial("bd dep add", firstLine(dep));
  }
  return { ok: true, id, reused: Boolean(existing), stored };
}

/** Files every request in order, then shows the board, notifies, and tells the caller once (design.md decision 1). */
async function fileAll(deps, requests, plan, chosen, stagedAll) {
  const { project, children } = plan;
  const itemId = requests[0].itemId;
  const single = requests.length === 1;
  const env = { pane: paneFrom(deps.env), socket: socketFrom(deps.env) };

  for (const [index, existing] of chosen.entries()) {
    if (existing && existing.count > 1) {
      const which = requests[index].card && reviewKeyOf(existing.review) !== null ? ` with key ${reviewKeyOf(existing.review)}` : "";
      deps.warn(`${PREFIX}${existing.count} open reviews for ${itemId}${which}; reusing the newest, ${existing.review.id}.`);
    }
  }
  if (!single) {
    const taken = new Set(chosen.filter(Boolean).map((c) => c.review.id));
    for (const child of children) {
      if (reviewKeyOf(child) === null && !taken.has(child.id)) {
        deps.warn(`${PREFIX}open review ${child.id} under ${itemId} has no key, so this call left it alone; close it or re-file it from a card.`);
      }
    }
  }

  const filed = [];
  for (const [index, request] of requests.entries()) {
    const result = await fileOne(deps, request, plan, chosen[index], stagedAll[index], env);
    if (result.ok) {
      filed.push({ request, ...result });
      continue;
    }
    if (single) {
      if (result.filedNothing) throw new Refusal(`${result.message} Nothing was filed.`);
      const retry = result.id === null ? "" : ` Re-run the same command to retry; it reuses ${result.id}.`;
      deps.warn(`${PREFIX}${result.message.replace(/\.$/, "")}.${retry}`);
      return { exitCode: 1 };
    }
    const done = filed.map((f) => f.id);
    if (result.id !== null) done.push(`${result.id} (incomplete)`);
    deps.warn(`${PREFIX}${result.message}`);
    deps.warn(
      `${PREFIX}stopped at ${request.cardPath}; filed so far: ${done.length === 0 ? "none" : done.join(", ")}. Re-run the same command to retry; it reuses filed reviews by key and files the rest.`,
    );
    return { exitCode: 1 };
  }

  const first = filed[0];
  const link = boardLink(requests[0].boardUrl, project.key, first.id);
  const queuedInOpenTab = await showInChrome(deps, requests[0].boardUrl, link);

  const headline = single ? first.request.headline : filed.map((f) => f.request.headline).join(" · ");
  const notified = await deps.run(
    "herdr",
    [
      "notification", "show", single ? `Review requested: ${project.key} ${itemId}` : `${filed.length} reviews requested: ${project.key} ${itemId}`,
      "--body", headline.slice(0, MAX_NOTIFICATION_BODY),
      "--sound", "request",
    ],
    { cwd: deps.cwd },
  );
  if (notified.code !== 0) deps.warn(`${PREFIX}herdr notification failed (${firstLine(notified)}).`);

  const ids = filed.map((f) => f.id).join(", ");
  if (env.pane === null) {
    deps.warn(
      `${PREFIX}HERDR_PANE_ID is not set to a pane id, so the decision cannot be pushed to this pane; read \`bd comments ${single ? first.id : "<id>"}\` for it${single ? "" : ` (${ids})`}.`,
    );
  } else if (env.socket === null) {
    deps.warn(
      `${PREFIX}HERDR_SOCKET_PATH is not set to an absolute socket path, so the decision cannot be pushed to this pane; read \`bd comments ${single ? first.id : "<id>"}\` for it${single ? "" : ` (${ids})`}.`,
    );
  }

  const images = (n) => `${n} image${n === 1 ? "" : "s"}`;
  if (single) {
    deps.out(`Review ${first.id} ${first.reused ? "updated" : "filed"} for ${itemId} in ${project.key} (${images(first.stored.length)}).`);
  } else {
    for (const f of filed) {
      deps.out(`Review ${f.id} ${f.reused ? "updated" : "filed"} for ${itemId} in ${project.key} (key ${f.request.key}, ${images(f.stored.length)}): ${f.request.headline}`);
    }
  }
  // Open reviews this call did not touch, so a renamed card file's second review is visible (design.md, risks).
  if (requests[0].card) {
    const touched = new Set(filed.map((f) => f.id));
    const others = children.filter((child) => !touched.has(child.id));
    if (others.length > 0) {
      deps.out(`Also open under ${itemId}: ${others.map((c) => `${c.id} (${reviewKeyOf(c) === null ? "no key" : `key ${reviewKeyOf(c)}`})`).join(", ")}.`);
    }
  }
  deps.out(`Board: ${link}`);
  if (queuedInOpenTab) deps.out(single ? "Review queued in the open breakdown tab." : "Reviews queued in the open breakdown tab.");
  deps.out(
    single
      ? `End your turn now and wait for a prompt in this pane with the decision (Review ${first.id} accepted|changes requested: …). If none arrives, read \`bd comments ${first.id}\`.`
      : `End your turn now and wait for one prompt in this pane per review (Review <id> accepted|changes requested: …); each is decided on its own. If none arrives, read \`bd comments <id>\`.`,
  );
  return { exitCode: 0 };
}
