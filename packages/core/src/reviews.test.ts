// Pure tests for the review contract (board-visual-reviews, task 1.1) and
// its decision-card keys (decision-card-reviews, task 1.3). The card
// fixtures are read from fixtures/review-cards/*.expected.json only; core has
// no YAML parser.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isInsideReviewRoot,
  MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH,
  MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH,
  MAX_REVIEW_ATTACHMENTS,
  MAX_REVIEW_ON_ACCEPT_STEP_LENGTH,
  MAX_REVIEW_ON_ACCEPT_STEPS,
  MAX_REVIEW_OPTION_LABEL_LENGTH,
  MAX_REVIEW_OPTION_TEXT_LENGTH,
  MAX_REVIEW_OPTIONS,
  MAX_REVIEW_QUESTION_LENGTH,
  MAX_REVIEW_COMMENT_AUTHOR_LENGTH,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_COMMENTS_CHARS,
  MAX_REVIEW_IMAGE_PATH_LENGTH,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_METADATA_CHARS,
  MAX_REVIEW_SOCKET_PATH_LENGTH,
  MAX_REVIEW_SUMMARY_LENGTH,
  normalizeDecisionCard,
  normalizeReviewComments,
  normalizeReviewMetadata,
  REVIEW_IMAGE_ROOT,
  reviewCard,
  type ReviewMetadata,
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

  it("keeps a valid socket, and leaves the key out when none is recorded", () => {
    expect(normalizeReviewMetadata({ pane: "w1:p2", socket: "/Users/x/.config/herdr/herdr.sock" })).toEqual({
      images: [],
      pane: "w1:p2",
      socket: "/Users/x/.config/herdr/herdr.sock",
      summary: "",
    });
    expect(normalizeReviewMetadata({ pane: "w1:p2", socket: null })).toEqual({ images: [], pane: "w1:p2", summary: "" });
    expect(normalizeReviewMetadata({ pane: "w1:p2", socket: "" })).toEqual({ images: [], pane: "w1:p2", summary: "" });
    expect(normalizeReviewMetadata({ pane: "w".repeat(64) })).toMatchObject({ pane: "w".repeat(64) });
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
    ["a pane that starts with '-'", { pane: "-rf" }],
    ["a pane that starts with ':'", { pane: ":p2" }],
    ["an over-long pane", { pane: "w".repeat(65) }],
    ["a non-string pane", { pane: 7 }],
    ["a relative socket", { socket: "herdr.sock" }],
    ["a socket with a control character", { socket: "/tmp/a\nb.sock" }],
    ["an over-long socket", { socket: `/${"s".repeat(MAX_REVIEW_SOCKET_PATH_LENGTH)}` }],
    ["a non-string socket", { socket: 7 }],
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

const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/review-cards/", import.meta.url));
const EXPECTED = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".expected.json")).sort();

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as Record<string, unknown>;
}

const optionA = { id: "A", label: "Track first" };
const optionB = { id: "B", label: "Drop now" };
const card = (extra: Record<string, unknown> = {}) => ({ images: [], pane: null, summary: "q?", question: "q?", ...extra });

describe("normalizeReviewMetadata decision cards", () => {
  it("finds every valid card fixture", () => {
    expect(EXPECTED).toEqual(["before-after.expected.json", "keyed-budget.expected.json", "long-recommendation.expected.json", "shlo-k54.4.1.1.expected.json"]);
  });

  it.each(EXPECTED)("normalizes %s to itself, byte for byte", (name) => {
    const raw = fixture(name);
    const review = normalizeReviewMetadata(raw);
    expect(review).not.toHaveProperty("invalid");
    expect(JSON.stringify(review)).toBe(JSON.stringify(raw));
  });

  it("normalizes a legacy review byte-identical to before cards existed", () => {
    const legacy = { images: [img(1)], pane: "w1:p2", socket: "/tmp/herdr.sock", summary: "Board header" };
    const before = `{"images":[${JSON.stringify(img(1))}],"pane":"w1:p2","socket":"/tmp/herdr.sock","summary":"Board header"}`;
    expect(JSON.stringify(normalizeReviewMetadata(legacy))).toBe(before);
    expect(JSON.stringify(normalizeReviewMetadata({ images: [], summary: "s" }))).toBe(`{"images":[],"pane":null,"summary":"s"}`);
    // Null, blank, and empty card keys are absent, not empty.
    for (const empty of [
      { question: "  ", options: null, recommend: null, on_accept: [], attachments: [] },
      { question: null, options: [], recommend: "", on_accept: ["", "  "], attachments: null },
    ]) {
      expect(JSON.stringify(normalizeReviewMetadata({ ...legacy, ...empty }))).toBe(before);
    }
  });

  it("keeps a card's keys in order, drops unknown keys in options and attachments, and trims text", () => {
    const review = normalizeReviewMetadata({
      attachments: [{ kind: "diff", source: " +a\n-b ", caption: " c ", extra: 1 }, { kind: "image", path: img(1), source: "ignored" }],
      on_accept: ["  push  "],
      recommend: "B",
      options: [{ ...optionA, what: "  w ", risk: "", extra: 1 }, { ...optionB, risk: null }],
      question: "  Drop it?  ",
      summary: "Drop it?",
    });
    expect(JSON.stringify(review)).toBe(
      JSON.stringify({
        images: [],
        pane: null,
        summary: "Drop it?",
        question: "Drop it?",
        options: [{ id: "A", label: "Track first", what: "w" }, { id: "B", label: "Drop now" }],
        recommend: "B",
        on_accept: ["push"],
        attachments: [{ kind: "diff", source: " +a\n-b ", caption: "c" }, { kind: "image", path: img(1) }],
      }),
    );
  });

  it("reads an empty options list and a blank recommend as absent, and drops blank on-accept steps", () => {
    expect(JSON.stringify(normalizeReviewMetadata(card({ options: [], recommend: "" })))).toBe(JSON.stringify(card()));
    expect(JSON.stringify(normalizeReviewMetadata(card({ options: [optionA, optionB], recommend: "" })))).toBe(JSON.stringify(card({ options: [optionA, optionB] })));
    // An empty options list cannot back a recommendation.
    expect(normalizeReviewMetadata(card({ options: [], recommend: "A" }))).toEqual({ invalid: true });
    const steps = normalizeReviewMetadata(card({ on_accept: ["  ", "push", "", " merge "] }));
    expect(steps).toMatchObject({ on_accept: ["push", "merge"] });
    expect(normalizeReviewMetadata(steps)).toEqual(steps);
  });

  it("accepts an attachment pair and every attachment kind", () => {
    const attachments = [
      { kind: "image", path: img(1), pair: "before" },
      { kind: "image", path: img(2), pair: "after" },
      { kind: "mermaid", source: "erDiagram\n  A ||--o{ B : has" },
    ];
    expect(normalizeReviewMetadata(card({ attachments }))).toMatchObject({ attachments });
  });

  it.each([
    ["a non-string question", { question: 7 }],
    ["options not an array", { options: optionA }],
    ["one option", { options: [optionA] }],
    ["too many options", { options: Array.from({ length: MAX_REVIEW_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, label: "l" })) }],
    ["an option that is not a plain object", { options: [optionA, "B"] }],
    ["an option id with a bad character", { options: [optionA, { id: "B C", label: "l" }] }],
    ["an option id that starts with '-'", { options: [optionA, { id: "-B", label: "l" }] }],
    ["an over-long option id", { options: [optionA, { id: "B".repeat(17), label: "l" }] }],
    ["a non-string option id", { options: [optionA, { id: 2, label: "l" }] }],
    ["a repeated option id", { options: [optionA, { id: "A", label: "again" }] }],
    ["a missing label", { options: [optionA, { id: "B" }] }],
    ["a blank label", { options: [optionA, { id: "B", label: "  " }] }],
    ["a non-string what", { options: [optionA, { ...optionB, what: 1 }] }],
    ["a non-string risk", { options: [optionA, { ...optionB, risk: ["r"] }] }],
    ["recommend without options", { recommend: "A" }],
    ["recommend naming no option", { options: [optionA, optionB], recommend: "D" }],
    ["a non-string recommend", { options: [optionA, optionB], recommend: 1 }],
    ["on_accept not an array", { on_accept: "push" }],
    ["too many on-accept steps", { on_accept: Array.from({ length: MAX_REVIEW_ON_ACCEPT_STEPS + 1 }, () => "s") }],
    ["a non-string on-accept step", { on_accept: ["push", 2] }],
    ["attachments not an array", { attachments: { kind: "diff", source: "" } }],
    ["too many attachments", { attachments: Array.from({ length: MAX_REVIEW_ATTACHMENTS + 1 }, () => ({ kind: "diff", source: "+" })) }],
    ["an attachment that is not a plain object", { attachments: ["diff"] }],
    ["an unknown attachment kind", { attachments: [{ kind: "video", path: img(1) }] }],
    ["an attachment without a kind", { attachments: [{ path: img(1) }] }],
    ["an image attachment without a path", { attachments: [{ kind: "image" }] }],
    ["a relative image attachment path", { attachments: [{ kind: "image", path: "shots/a.png" }] }],
    ["an over-long image attachment path", { attachments: [{ kind: "image", path: `/${"a".repeat(MAX_REVIEW_IMAGE_PATH_LENGTH)}` }] }],
    ["a control character in an image attachment path", { attachments: [{ kind: "image", path: "/tmp/a\nb.png" }] }],
    ["a mermaid attachment without a source", { attachments: [{ kind: "mermaid" }] }],
    ["a diff attachment with a non-string source", { attachments: [{ kind: "diff", source: ["+a"] }] }],
    ["an unknown pair", { attachments: [{ kind: "image", path: img(1), pair: "during" }] }],
    ["a non-string caption", { attachments: [{ kind: "image", path: img(1), caption: 3 }] }],
  ])("marks a card with %s invalid", (_label, extra) => {
    expect(normalizeReviewMetadata(card(extra))).toEqual({ invalid: true });
  });

  it("accepts exactly the option, step, and attachment caps", () => {
    const options = Array.from({ length: MAX_REVIEW_OPTIONS }, (_, i) => ({ id: `o-${i}_${"x".repeat(12)}`, label: "l" }));
    const on_accept = Array.from({ length: MAX_REVIEW_ON_ACCEPT_STEPS }, (_, i) => `step ${i}`);
    const attachments = Array.from({ length: MAX_REVIEW_ATTACHMENTS }, (_, i) => ({ kind: "image", path: img(i) }));
    expect(options[0]!.id).toHaveLength(16);
    expect(normalizeReviewMetadata(card({ options, recommend: options.at(-1)!.id, on_accept, attachments }))).toMatchObject({ options, on_accept, attachments });
  });

  it("fits every over-long text field instead of refusing", () => {
    const over = (max: number, ch = "x") => ch.repeat(max + 25);
    const review = normalizeReviewMetadata({
      question: over(MAX_REVIEW_QUESTION_LENGTH),
      options: [
        { id: "A", label: over(MAX_REVIEW_OPTION_LABEL_LENGTH), what: over(MAX_REVIEW_OPTION_TEXT_LENGTH), risk: over(MAX_REVIEW_OPTION_TEXT_LENGTH) },
        optionB,
      ],
      on_accept: [over(MAX_REVIEW_ON_ACCEPT_STEP_LENGTH)],
      attachments: [{ kind: "mermaid", source: over(MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH), caption: over(MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH) }],
    }) as ReviewMetadata;
    expect(review.question).toBe("x".repeat(MAX_REVIEW_QUESTION_LENGTH));
    expect(review.options?.[0]).toEqual({
      id: "A",
      label: "x".repeat(MAX_REVIEW_OPTION_LABEL_LENGTH),
      what: "x".repeat(MAX_REVIEW_OPTION_TEXT_LENGTH),
      risk: "x".repeat(MAX_REVIEW_OPTION_TEXT_LENGTH),
    });
    expect(review.on_accept).toEqual(["x".repeat(MAX_REVIEW_ON_ACCEPT_STEP_LENGTH)]);
    expect(review.attachments).toEqual([
      { kind: "mermaid", source: "x".repeat(MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH), caption: "x".repeat(MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH) },
    ]);
    expect(normalizeReviewMetadata(review)).toEqual(review);
  });

  it("is idempotent when a fitted cut lands on a space", () => {
    const spaced = (max: number) => `${"x".repeat(max - 1)} ${"y".repeat(10)}`;
    const raw = {
      question: spaced(MAX_REVIEW_QUESTION_LENGTH),
      options: [{ id: "A", label: spaced(MAX_REVIEW_OPTION_LABEL_LENGTH), what: spaced(MAX_REVIEW_OPTION_TEXT_LENGTH) }, optionB],
      on_accept: [spaced(MAX_REVIEW_ON_ACCEPT_STEP_LENGTH)],
      attachments: [{ kind: "image", path: img(1), caption: spaced(MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH) }],
    };
    const once = normalizeReviewMetadata(raw) as ReviewMetadata;
    expect(once.question).toBe("x".repeat(MAX_REVIEW_QUESTION_LENGTH - 1));
    expect(once.on_accept).toEqual(["x".repeat(MAX_REVIEW_ON_ACCEPT_STEP_LENGTH - 1)]);
    expect(JSON.stringify(normalizeReviewMetadata(once))).toBe(JSON.stringify(once));
  });

  it("does not split a surrogate pair when fitting the question", () => {
    const review = normalizeReviewMetadata({ question: `${"x".repeat(MAX_REVIEW_QUESTION_LENGTH - 1)}😀` }) as ReviewMetadata;
    expect(review.question).toBe("x".repeat(MAX_REVIEW_QUESTION_LENGTH - 1));
  });

  it("replaces NUL with U+FFFD in every card text field", () => {
    const review = normalizeReviewMetadata({
      question: "q\u0000",
      options: [{ id: "A", label: "l\u0000", what: "w\u0000", risk: "r\u0000" }, optionB],
      on_accept: ["s\u0000"],
      attachments: [{ kind: "diff", source: "+\u0000", caption: "c\u0000" }],
    });
    expect(review).toMatchObject({
      question: "q�",
      options: [{ id: "A", label: "l�", what: "w�", risk: "r�" }, optionB],
      on_accept: ["s�"],
      attachments: [{ kind: "diff", source: "+�", caption: "c�" }],
    });
    expect(JSON.stringify(review)).not.toContain("\\u0000");
  });

  it("marks a card whose JSON exceeds MAX_REVIEW_METADATA_CHARS after fitting invalid", () => {
    const attachments = Array.from({ length: 3 }, () => ({ kind: "diff", source: "+".repeat(MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH) }));
    expect(normalizeReviewMetadata(card({ attachments: attachments.slice(0, 1) }))).toMatchObject({ attachments: attachments.slice(0, 1) });
    expect(normalizeReviewMetadata(card({ attachments }))).toEqual({ invalid: true });
  });

  it("is idempotent on a card", () => {
    for (const name of EXPECTED) {
      const once = normalizeReviewMetadata(fixture(name));
      expect(normalizeReviewMetadata(once)).toEqual(once);
    }
  });
});

describe("normalizeReviewMetadata review keys", () => {
  it("keeps a valid key after the summary and before the card", () => {
    const review = normalizeReviewMetadata({ question: "q?", key: "budget", summary: "q?", images: [] });
    expect(JSON.stringify(review)).toBe(`{"images":[],"pane":null,"summary":"q?","key":"budget","question":"q?"}`);
    expect(normalizeReviewMetadata(review)).toEqual(review);
  });

  it("accepts the shortest and longest keys", () => {
    for (const key of ["a", "0", `a${"-".repeat(39)}`, "shlo-k54-4-1-1", "a_b"]) {
      expect(normalizeReviewMetadata(card({ key }))).toMatchObject({ key });
    }
  });

  it("reads a missing, null, or empty key as absent", () => {
    for (const extra of [{}, { key: null }, { key: "" }]) {
      expect(normalizeReviewMetadata(card(extra))).not.toHaveProperty("key");
    }
  });

  it("marks a review with a key outside the pattern invalid", () => {
    for (const key of ["Has Spaces", "Upper", "-lead", "_lead", `a${"b".repeat(40)}`, "a.b", 7, true, ["a"]]) {
      expect(normalizeReviewMetadata(card({ key }))).toEqual({ invalid: true });
    }
  });
});

describe("normalizeDecisionCard", () => {
  it("normalizes the card keys alone and ignores everything else", () => {
    expect(
      normalizeDecisionCard({
        question: "  Track or ignore?  ",
        options: [{ id: "track", label: "Track" }, { id: "ignore", label: "Ignore", risk: "  lose it " }],
        recommend: "ignore",
        on_accept: ["close the batch", "  "],
        images: "not a card key",
      }),
    ).toEqual({
      question: "Track or ignore?",
      options: [{ id: "track", label: "Track" }, { id: "ignore", label: "Ignore", risk: "lose it" }],
      recommend: "ignore",
      on_accept: ["close the batch"],
    });
  });

  it("is empty for a record without card keys, and idempotent", () => {
    expect(normalizeDecisionCard({})).toEqual({});
    const once = normalizeDecisionCard({ question: "Q?", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], recommend: "B" })!;
    expect(normalizeDecisionCard({ ...once })).toEqual(once);
  });

  it("cuts long text, and is null when a key breaks the contract", () => {
    const two = [{ id: "A", label: "a" }, { id: "B", label: "b" }];
    expect(normalizeDecisionCard({ question: "x".repeat(MAX_REVIEW_QUESTION_LENGTH + 1) })).toEqual({ question: "x".repeat(MAX_REVIEW_QUESTION_LENGTH) });
    expect(normalizeDecisionCard({ options: two, recommend: "C" })).toBeNull();
    expect(normalizeDecisionCard({ recommend: "A" })).toBeNull();
    expect(normalizeDecisionCard({ options: [two[0]] })).toBeNull();
    expect(normalizeDecisionCard({ options: [two[0], two[0]] })).toBeNull();
    expect(normalizeDecisionCard({ on_accept: "do it" })).toBeNull();
  });
});

describe("reviewCard", () => {
  it("reads a legacy review as a question-only card: the summary's first line, its images as attachments", () => {
    const legacy = normalizeReviewMetadata({ images: [img(1), img(2)], pane: "w1:p2", summary: "  Board header\nSecond line" }) as ReviewMetadata;
    expect(reviewCard(legacy)).toEqual({
      question: "Board header",
      options: [],
      recommend: null,
      onAccept: [],
      attachments: [{ kind: "image", path: img(1) }, { kind: "image", path: img(2) }],
    });
  });

  it("fits a legacy summary's first line to the question cap, and reads an empty summary as an empty question", () => {
    const long = normalizeReviewMetadata({ summary: `${"s".repeat(MAX_REVIEW_QUESTION_LENGTH + 10)}\r\nmore` }) as ReviewMetadata;
    expect(reviewCard(long).question).toBe("s".repeat(MAX_REVIEW_QUESTION_LENGTH));
    expect(reviewCard(normalizeReviewMetadata({}) as ReviewMetadata)).toEqual({ question: "", options: [], recommend: null, onAccept: [], attachments: [] });
  });

  it("trims a legacy summary's first line again after fitting it", () => {
    const spaced = normalizeReviewMetadata({ summary: `${"s".repeat(MAX_REVIEW_QUESTION_LENGTH - 1)} tail` }) as ReviewMetadata;
    expect(reviewCard(spaced).question).toBe("s".repeat(MAX_REVIEW_QUESTION_LENGTH - 1));
  });

  it("appends images no image attachment carries, so a hand-edited review never hides a screenshot", () => {
    const review = normalizeReviewMetadata({
      images: [img(1), img(2), img(3)],
      question: "q?",
      attachments: [{ kind: "diff", source: "+a" }, { kind: "image", path: img(2), pair: "after" }],
    }) as ReviewMetadata;
    expect(reviewCard(review).attachments).toEqual([
      { kind: "diff", source: "+a" },
      { kind: "image", path: img(2), pair: "after" },
      { kind: "image", path: img(1) },
      { kind: "image", path: img(3) },
    ]);
  });

  it("reads a card's own keys, preferring its attachments to images", () => {
    const shlo = normalizeReviewMetadata(fixture("shlo-k54.4.1.1.expected.json")) as ReviewMetadata;
    const read = reviewCard(shlo);
    expect(read.question).toBe("Drop omni_search v5–v8 on or after 2026-11-12 if the 7-day delta shows zero calls?");
    expect(read.options.map((o) => o.id)).toEqual(["A", "B", "C"]);
    expect(read.recommend).toBe("A");
    expect(read.onAccept).toHaveLength(3);
    expect(read.attachments.map((a) => a.kind)).toEqual(["diff"]);

    const beforeAfter = normalizeReviewMetadata(fixture("before-after.expected.json")) as ReviewMetadata;
    expect(reviewCard(beforeAfter).attachments.map((a) => [a.kind, a.pair])).toEqual([
      ["image", "before"],
      ["image", "after"],
      ["mermaid", undefined],
    ]);
    expect(reviewCard(beforeAfter)).toMatchObject({ options: [], recommend: null });

    // A card without attachments falls back to its images, like a legacy review.
    expect(reviewCard(normalizeReviewMetadata({ images: [img(1)], question: "q?" }) as ReviewMetadata).attachments).toEqual([{ kind: "image", path: img(1) }]);
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
