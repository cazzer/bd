// Tests for lib/reviewAttachments.ts (review-queue, tasks.md 6.1;
// decision-card-reviews, tasks.md 6.2 and 6.5).

import { describe, expect, it } from "vitest";
import { attachmentLabel, attachmentsOfKind, pairAttachments, reviewAttachments, type ReviewAttachment } from "./reviewAttachments.js";

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

describe("attachmentLabel", () => {
  it("is the caption, else an image's file name, behind its Before/After label", () => {
    expect(attachmentLabel({ kind: "image", name: "a.png", path: "/a.png", src: null })).toBe("a.png");
    expect(attachmentLabel({ kind: "image", name: "a.png", path: "/a.png", src: null, caption: "Header" })).toBe("Header");
    expect(attachmentLabel({ kind: "diff", source: "+", pair: "before" })).toBe("Before");
    expect(attachmentLabel({ kind: "mermaid", source: "g", caption: "Flow", pair: "after" })).toBe("After: Flow");
    expect(attachmentLabel({ kind: "diff", source: "+" })).toBeUndefined();
  });
});
