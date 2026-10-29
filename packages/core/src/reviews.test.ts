// Pure tests for the review contract (board-visual-reviews, task 1.1).

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInsideReviewRoot,
  MAX_REVIEW_COMMENT_AUTHOR_LENGTH,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_COMMENTS_CHARS,
  MAX_REVIEW_IMAGE_PATH_LENGTH,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_METADATA_CHARS,
  MAX_REVIEW_SUMMARY_LENGTH,
  normalizeReviewComments,
  normalizeReviewMetadata,
  REVIEW_IMAGE_ROOT,
} from "./reviews.js";

const img = (n: number) => path.join(REVIEW_IMAGE_ROOT, "proj", "bd-1", `${String(n).padStart(2, "0")}-shot.png`);

describe("normalizeReviewMetadata", () => {
  it("keeps a valid review and drops unknown keys", () => {
    expect(normalizeReviewMetadata({ images: [img(1), img(2)], pane: " w1:p2 ", summary: "  look at the header  ", extra: 1 })).toEqual({
      images: [img(1), img(2)],
      pane: "w1:p2",
      summary: "look at the header",
    });
  });

  it("defaults absent, null, and blank fields", () => {
    expect(normalizeReviewMetadata({})).toEqual({ images: [], pane: null, summary: "" });
    expect(normalizeReviewMetadata({ images: null, pane: null, summary: null })).toEqual({ images: [], pane: null, summary: "" });
    expect(normalizeReviewMetadata({ pane: "   " })).toEqual({ images: [], pane: null, summary: "" });
  });

  it("fits an over-long summary instead of refusing", () => {
    const review = normalizeReviewMetadata({ summary: "s".repeat(MAX_REVIEW_SUMMARY_LENGTH + 50) });
    expect(review).toEqual({ images: [], pane: null, summary: "s".repeat(MAX_REVIEW_SUMMARY_LENGTH) });
  });

  it.each([
    ["not an object", "review"],
    ["an array", [img(1)]],
    ["null", null],
    ["images not an array", { images: img(1) }],
    ["too many images", { images: Array.from({ length: MAX_REVIEW_IMAGES + 1 }, (_, i) => img(i)) }],
    ["a relative image path", { images: ["shots/a.png"] }],
    ["an over-long image path", { images: [`/${"a".repeat(MAX_REVIEW_IMAGE_PATH_LENGTH)}`] }],
    ["a NUL in an image path", { images: ["/tmp/a\u0000.png"] }],
    ["a non-string image", { images: [42] }],
    ["a bad pane", { pane: "pane; rm -rf ~" }],
    ["a non-string pane", { pane: 7 }],
    ["a non-string summary", { summary: { text: "x" } }],
  ])("marks %s invalid", (_label, raw) => {
    expect(normalizeReviewMetadata(raw)).toEqual({ invalid: true });
  });

  it("accepts exactly the image caps", () => {
    const images = Array.from({ length: MAX_REVIEW_IMAGES }, (_, i) => img(i));
    expect(normalizeReviewMetadata({ images })).toMatchObject({ images });
    const longest = `/${"a".repeat(MAX_REVIEW_IMAGE_PATH_LENGTH - 1)}`;
    expect(normalizeReviewMetadata({ images: [longest] })).toMatchObject({ images: [longest] });
  });

  it("refuses control characters in image paths, so twenty escaped paths cannot blow the metadata cap", () => {
    const probe = Array.from({ length: MAX_REVIEW_IMAGES }, () => `/${"\u0001".repeat(MAX_REVIEW_IMAGE_PATH_LENGTH - 1)}`);
    expect(JSON.stringify(probe).length).toBeGreaterThan(60_000);
    expect(normalizeReviewMetadata({ images: probe })).toEqual({ invalid: true });
    expect(normalizeReviewMetadata({ images: ["/tmp/a\nb.png"] })).toEqual({ invalid: true });
  });

  it("marks a review whose JSON exceeds MAX_REVIEW_METADATA_CHARS invalid, and keeps a control-character summary under it", () => {
    const summary = "\u0001".repeat(MAX_REVIEW_SUMMARY_LENGTH);
    const alone = normalizeReviewMetadata({ summary });
    expect(alone).toEqual({ images: [], pane: null, summary });
    expect(JSON.stringify(alone).length).toBeLessThanOrEqual(MAX_REVIEW_METADATA_CHARS);
    const images = Array.from({ length: MAX_REVIEW_IMAGES }, (_, i) => `/${String(i).padStart(2, "0")}${"a".repeat(MAX_REVIEW_IMAGE_PATH_LENGTH - 3)}`);
    expect(normalizeReviewMetadata({ images, summary })).toEqual({ invalid: true });
  });

  it("replaces NUL in the summary with U+FFFD", () => {
    expect(normalizeReviewMetadata({ summary: "a\u0000b" })).toEqual({ images: [], pane: null, summary: "a\uFFFDb" });
  });

  it("is idempotent, including on a stored invalid marker", () => {
    const valid = normalizeReviewMetadata({ images: [img(1)], pane: "p1", summary: "s" });
    expect(normalizeReviewMetadata(valid)).toEqual(valid);
    expect(normalizeReviewMetadata({ invalid: true })).toEqual({ invalid: true });
  });
});

describe("normalizeReviewComments", () => {
  it("orders oldest first, drops rows without string text, and fits fields", () => {
    const comments = normalizeReviewComments([
      { id: 3, author: "c", text: "third", created_at: "2026-10-03T00:00:00Z" },
      { id: 1, author: "a", text: "first", created_at: "2026-10-01T00:00:00+02:00" },
      { id: 9, author: "x", text: 9 },
      "not a row",
      null,
      { id: 2, author: "", text: "t".repeat(MAX_REVIEW_COMMENT_LENGTH + 10), created_at: "2026-10-02T00:00:00Z" },
      { id: "u", author: "a".repeat(MAX_REVIEW_COMMENT_AUTHOR_LENGTH + 5), text: "undated", created_at: "whenever" },
    ]);
    expect(comments).toEqual([
      { id: "u", author: "a".repeat(MAX_REVIEW_COMMENT_AUTHOR_LENGTH), text: "undated", created_at: null },
      { id: "1", author: "a", text: "first", created_at: "2026-09-30T22:00:00.000Z" },
      { id: "2", author: null, text: "t".repeat(MAX_REVIEW_COMMENT_LENGTH), created_at: "2026-10-02T00:00:00.000Z" },
      { id: "3", author: "c", text: "third", created_at: "2026-10-03T00:00:00.000Z" },
    ]);
  });

  it("keeps input order for equal times and answers [] for a non-array", () => {
    const at = "2026-10-01T00:00:00Z";
    expect(normalizeReviewComments([{ id: "b", text: "b", created_at: at }, { id: "a", text: "a", created_at: at }]).map((c) => c.id)).toEqual(["b", "a"]);
    expect(normalizeReviewComments(undefined)).toEqual([]);
    expect(normalizeReviewComments({ text: "x" })).toEqual([]);
  });

  it("keeps the last MAX_REVIEW_COMMENTS", () => {
    const raw = Array.from({ length: MAX_REVIEW_COMMENTS + 5 }, (_, i) => ({ id: i, text: `c${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const kept = normalizeReviewComments(raw);
    expect(kept).toHaveLength(MAX_REVIEW_COMMENTS);
    expect(kept[0]?.id).toBe("5");
    expect(kept.at(-1)?.id).toBe(String(MAX_REVIEW_COMMENTS + 4));
  });

  it("drops the oldest until the list fits the character budget, always keeping the newest", () => {
    const raw = Array.from({ length: MAX_REVIEW_COMMENTS }, (_, i) => ({ id: i, author: "agent", text: "x".repeat(MAX_REVIEW_COMMENT_LENGTH), created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const kept = normalizeReviewComments(raw);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_REVIEW_COMMENTS_CHARS);
    expect(kept.length).toBeGreaterThan(1);
    expect(JSON.stringify(normalizeReviewComments(raw.slice(-(kept.length + 1)))).length).toBe(JSON.stringify(kept).length);
    expect(kept.at(-1)?.id).toBe(String(MAX_REVIEW_COMMENTS - 1));

    // A newest comment whose JSON alone exceeds the budget (control characters escape six-fold) is kept, its text cut to fit.
    const author = "\u0001".repeat(MAX_REVIEW_COMMENT_AUTHOR_LENGTH);
    const huge = normalizeReviewComments([
      { id: 1, author, text: "\u0001".repeat(MAX_REVIEW_COMMENT_LENGTH) },
      { id: 2, author, text: "\u0001".repeat(MAX_REVIEW_COMMENT_LENGTH) },
    ]);
    expect(huge.map((c) => c.id)).toEqual(["2"]);
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(MAX_REVIEW_COMMENTS_CHARS);
    expect(huge[0]!.text.length).toBeGreaterThan(MAX_REVIEW_COMMENT_LENGTH - 500);
    expect(normalizeReviewComments(huge)).toEqual(huge);
  });

  it("replaces NUL in text, author, and id with U+FFFD and is idempotent", () => {
    const once = normalizeReviewComments([{ id: "a\u0000", author: "x\u0000y", text: "t\u0000", created_at: "2026-10-01T00:00:00Z" }, { id: 7, text: "plain" }]);
    expect(once).toEqual([
      { id: "7", author: null, text: "plain", created_at: null },
      { id: "a\uFFFD", author: "x\uFFFDy", text: "t\uFFFD", created_at: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(normalizeReviewComments(once)).toEqual(once);
  });
});

describe("isInsideReviewRoot", () => {
  const root = "/home/u/.local/share/breakdown/reviews";
  it("accepts a path inside the root", () => {
    expect(isInsideReviewRoot(`${root}/proj/bd-1/01-a.png`, root)).toBe(true);
    expect(isInsideReviewRoot(img(1))).toBe(true);
  });
  it("refuses the root itself, an escape through .., a sibling with the root as prefix, and an unrelated path", () => {
    expect(isInsideReviewRoot(root, root)).toBe(false);
    expect(isInsideReviewRoot(`${root}/`, root)).toBe(false);
    expect(isInsideReviewRoot(`${root}/../x`, root)).toBe(false);
    expect(isInsideReviewRoot(`${root}/proj/../../x`, root)).toBe(false);
    expect(isInsideReviewRoot(`${root}-evil/x`, root)).toBe(false);
    expect(isInsideReviewRoot("/etc/passwd", root)).toBe(false);
  });
});
