// Tests for lib/reviewAttachments.ts (review-queue, tasks.md 6.1;
// decision-card-reviews, tasks.md 6.2 and 6.5).

import { describe, expect, it } from "vitest";
import {
  appendNote,
  attachmentLabel,
  attachmentsOfKind,
  formatVideoTime,
  optionVideos,
  pairAttachments,
  reviewAttachments,
  timestampNote,
  type ReviewAttachment,
  type VideoAttachment,
} from "./reviewAttachments.js";

describe("reviewAttachments", () => {
  it("turns each card image into an image attachment, order kept, versioned by the item's update time", () => {
    const attachments = reviewAttachments({
      updatedAt: "2026-11-05T12:00:00.000Z",
      card: {
        attachments: [
          { kind: "image", name: "a.png", path: "/r/a.png", url: "/review-images/a.png" },
          { kind: "image", name: "b.png", path: "/elsewhere/b.png", url: null },
        ],
      },
    });
    expect(attachments).toEqual([
      { kind: "image", name: "a.png", path: "/r/a.png", src: "/review-images/a.png?v=2026-11-05T12%3A00%3A00.000Z" },
      { kind: "image", name: "b.png", path: "/elsewhere/b.png", src: null },
    ]);
  });

  it("keeps diagrams and diffs with their source, and every attachment's caption and pair", () => {
    const attachments = reviewAttachments({
      updatedAt: "t",
      card: {
        attachments: [
          { kind: "image", name: "b.png", path: "/r/b.png", url: "/u/b.png", caption: "Today", pair: "before" },
          { kind: "mermaid", source: "graph TD; a-->b", caption: "Flow" },
          { kind: "diff", source: "+x", pair: "after" },
        ],
      },
    });
    expect(attachments).toEqual([
      { kind: "image", name: "b.png", path: "/r/b.png", src: "/u/b.png?v=t", caption: "Today", pair: "before" },
      { kind: "mermaid", source: "graph TD; a-->b", caption: "Flow" },
      { kind: "diff", source: "+x", pair: "after" },
    ]);
  });

  it("turns a card video into a video attachment, its src and poster versioned like an image's", () => {
    const attachments = reviewAttachments({
      updatedAt: "t",
      card: {
        attachments: [
          { kind: "video", name: "a.mp4", path: "/r/a.mp4", url: "/u/a.mp4", posterUrl: "/u/a.jpg", caption: "Cut 1", option: "A" },
          { kind: "video", name: "b.webm", path: "/x/b.webm", url: null, posterUrl: null, pair: "after" },
        ],
      },
    });
    expect(attachments).toEqual([
      { kind: "video", name: "a.mp4", path: "/r/a.mp4", src: "/u/a.mp4?v=t", poster: "/u/a.jpg?v=t", option: "A", caption: "Cut 1" },
      { kind: "video", name: "b.webm", path: "/x/b.webm", src: null, poster: null, pair: "after" },
    ]);
  });

  it("is empty for an item with no card (not a review, or a malformed one) or a card with no attachments", () => {
    expect(reviewAttachments({ updatedAt: "x", card: null })).toEqual([]);
    expect(reviewAttachments({ updatedAt: "x", card: { attachments: [] } })).toEqual([]);
  });
});

describe("attachmentsOfKind", () => {
  it("keeps the attachments of the kind asked for, order kept", () => {
    const list: ReviewAttachment[] = [
      { kind: "diff", source: "1" },
      { kind: "image", name: "a", path: "a", src: "u" },
      { kind: "diff", source: "2" },
    ];
    expect(attachmentsOfKind(list, "image")).toEqual([list[1]]);
    expect(attachmentsOfKind(list, "diff")).toEqual([list[0], list[2]]);
    expect(attachmentsOfKind(list, "mermaid")).toEqual([]);
  });
});

describe("pairAttachments", () => {
  const img = (name: string, pair?: "before" | "after"): ReviewAttachment => ({ kind: "image", name, path: `/r/${name}`, src: null, ...(pair ? { pair } : {}) });

  it("pairs a before immediately followed by an after, whatever their kinds, and keeps the rest in order", () => {
    const before = img("before.png", "before");
    const after = img("after.png", "after");
    const diagram: ReviewAttachment = { kind: "mermaid", source: "erDiagram" };
    const diffBefore: ReviewAttachment = { kind: "diff", source: "-a", pair: "before" };
    const diagramAfter: ReviewAttachment = { kind: "mermaid", source: "graph", pair: "after" };
    expect(pairAttachments([before, after, diagram, diffBefore, diagramAfter])).toEqual({
      pairs: [
        { before, after },
        { before: diffBefore, after: diagramAfter },
      ],
      rest: [diagram],
    });
  });

  it("leaves a before with no after right behind it, and an after with no before right ahead of it, unpaired", () => {
    const loneBefore = img("1", "before");
    const between = img("2");
    const loneAfter = img("3", "after");
    const after = img("4", "after");
    const before = img("5", "before");
    expect(pairAttachments([loneBefore, between, loneAfter, after, before])).toEqual({ pairs: [], rest: [loneBefore, between, loneAfter, after, before] });
  });

  it("pairs an after only with the before right ahead of it (after, before, after → one pair)", () => {
    const a1 = img("a1", "after");
    const b = img("b", "before");
    const a2 = img("a2", "after");
    expect(pairAttachments([a1, b, a2])).toEqual({ pairs: [{ before: b, after: a2 }], rest: [a1] });
  });

  it("leaves a legacy review's screenshots alone", () => {
    const list = [img("1"), img("2")];
    expect(pairAttachments(list)).toEqual({ pairs: [], rest: list });
  });
});

describe("optionVideos", () => {
  const video = (name: string, option?: string): VideoAttachment => ({ kind: "video", name, path: `/r/${name}`, src: null, poster: null, ...(option ? { option } : {}) });

  it("takes each option's video out in the card's option order, and keeps the rest in order", () => {
    const b = video("b.mp4", "B");
    const raw = video("raw.mp4");
    const a = video("a.mp4", "A");
    const diff: ReviewAttachment = { kind: "diff", source: "+" };
    expect(optionVideos([b, raw, diff, a], ["A", "B", "C"])).toEqual({
      byOption: [
        { optionId: "A", video: a },
        { optionId: "B", video: b },
      ],
      rest: [raw, diff],
    });
  });

  it("leaves a video naming an option the card does not offer in the rest", () => {
    const c = video("c.mp4", "C");
    expect(optionVideos([c], ["A", "B"])).toEqual({ byOption: [], rest: [c] });
    expect(optionVideos([c], [])).toEqual({ byOption: [], rest: [c] });
  });
});

describe("formatVideoTime", () => {
  it.each([
    [0, "0:00"],
    [7.4, "0:07"],
    [7.99, "0:07"],
    [59.9, "0:59"],
    [60, "1:00"],
    [605, "10:05"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3725, "1:02:05"],
    [Number.NaN, "0:00"],
    [-3, "0:00"],
    [Number.POSITIVE_INFINITY, "0:00"],
  ])("%s seconds → %s", (seconds, text) => {
    expect(formatVideoTime(seconds)).toBe(text);
  });
});

describe("timestampNote and appendNote", () => {
  it("is the time, behind an option id when the video is an option's cut, with a space to type after", () => {
    expect(timestampNote(7.4)).toBe("0:07 ");
    expect(timestampNote(7.4, "B")).toBe("B 0:07 ");
  });

  it("puts each note on a new line, or alone in an empty message", () => {
    expect(appendNote("", "A 0:07 ")).toBe("A 0:07 ");
    expect(appendNote("A 0:07 text too small", "B 0:03 ")).toBe("A 0:07 text too small\nB 0:03 ");
    expect(appendNote("first\n", "0:01 ")).toBe("first\n0:01 ");
  });
});

describe("attachmentLabel", () => {
  it("is a video's caption, else its file name", () => {
    expect(attachmentLabel({ kind: "video", name: "a.mp4", path: "/a.mp4", src: null, poster: null })).toBe("a.mp4");
    expect(attachmentLabel({ kind: "video", name: "a.mp4", path: "/a.mp4", src: null, poster: null, caption: "Cut 1", pair: "before" })).toBe("Before: Cut 1");
  });

  it("is the caption, else an image's file name, behind its Before/After label", () => {
    expect(attachmentLabel({ kind: "image", name: "a.png", path: "/a.png", src: null })).toBe("a.png");
    expect(attachmentLabel({ kind: "image", name: "a.png", path: "/a.png", src: null, caption: "Header" })).toBe("Header");
    expect(attachmentLabel({ kind: "diff", source: "+", pair: "before" })).toBe("Before");
    expect(attachmentLabel({ kind: "mermaid", source: "g", caption: "Flow", pair: "after" })).toBe("After: Flow");
    expect(attachmentLabel({ kind: "diff", source: "+" })).toBeUndefined();
  });
});
