// Tests for lib/reviewAttachments.ts (review-queue, tasks.md 6.1).

import { describe, expect, it } from "vitest";
import { attachmentsOfKind, reviewAttachments } from "./reviewAttachments.js";

describe("reviewAttachments", () => {
  it("turns each review image into an image attachment, order kept, versioned by the item's update time", () => {
    const attachments = reviewAttachments({
      updatedAt: "2026-11-05T12:00:00.000Z",
      reviewImages: [
        { name: "a.png", path: "/r/a.png", url: "/review-images/a.png" },
        { name: "b.png", path: "/elsewhere/b.png", url: null },
      ],
    });
    expect(attachments).toEqual([
      { kind: "image", name: "a.png", path: "/r/a.png", src: "/review-images/a.png?v=2026-11-05T12%3A00%3A00.000Z" },
      { kind: "image", name: "b.png", path: "/elsewhere/b.png", src: null },
    ]);
  });

  it("is empty for an item with no images", () => {
    expect(reviewAttachments({ updatedAt: "x", reviewImages: [] })).toEqual([]);
  });
});

describe("attachmentsOfKind", () => {
  it("keeps the attachments of the kind asked for", () => {
    const list = reviewAttachments({ updatedAt: "t", reviewImages: [{ name: "a", path: "a", url: "u" }] });
    expect(attachmentsOfKind(list, "image")).toEqual(list);
  });
});
