// toBoardItemDto's `card` (decision-card-reviews, tasks.md 6.1): the drawer
// reads a review as core's `reviewCard`, served here because the client
// cannot import core. Pure: no database.

import path from "node:path";
import { normalizeReviewMetadata, reviewCard, type BoardItem, type ReviewMetadata } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import { toBoardItemDto } from "./dto.js";

const ROOT = "/home/me/.local/share/breakdown/reviews";

function item(review: BoardItem["review"]): BoardItem {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    externalId: "bd-1",
    sourceSystem: "beads",
    project: "bd",
    title: "Review: x",
    content: "",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    labels: ["review"],
    closedAt: null,
    closedReason: null,
    updatedAt: new Date("2026-11-05T12:00:00.000Z"),
    isReview: review !== null,
    review,
    comments: [],
    parent: null,
  };
}

function normalized(raw: unknown): ReviewMetadata {
  const review = normalizeReviewMetadata(raw);
  if ("invalid" in review) throw new Error("fixture must normalize");
  return review;
}

describe("toBoardItemDto card", () => {
  it("is core's reviewCard for a card, each image attachment carrying its name and route URL", () => {
    const before = path.join(ROOT, "bd", "bd-1", "before.png");
    const review = normalized({
      images: [before],
      pane: null,
      summary: "Move the picker?",
      question: "Move the picker?",
      options: [
        { id: "A", label: "Move it", what: "Into the header.", risk: "None." },
        { id: "B", label: "Leave it" },
      ],
      recommend: "A",
      on_accept: ["Move it."],
      attachments: [
        { kind: "image", path: before, caption: "Today", pair: "before" },
        { kind: "image", path: "/elsewhere/after.png", pair: "after" },
        { kind: "diff", source: "+x" },
      ],
    });
    const dto = toBoardItemDto(item(review), ROOT);
    const card = reviewCard(review);
    expect(dto.card).toEqual({
      ...card,
      attachments: [
        { kind: "image", path: before, caption: "Today", pair: "before", name: "before.png", url: "/review-images/bd/bd-1/before.png" },
        { kind: "image", path: "/elsewhere/after.png", pair: "after", name: "after.png", url: null },
        { kind: "diff", source: "+x" },
      ],
    });
    expect(dto.card?.question).toBe(card.question);
    expect(dto.card?.options).toEqual(card.options);
  });

  it("reads a legacy review as a question-only card with its images, beside the unchanged reviewImages", () => {
    const shot = path.join(ROOT, "bd", "bd-1", "01.png");
    const review = normalized({ images: [shot], pane: "w1:p1", summary: "Board header\nmore detail" });
    const dto = toBoardItemDto(item(review), ROOT);
    expect(dto.card).toEqual({
      question: "Board header",
      options: [],
      recommend: null,
      onAccept: [],
      attachments: [{ kind: "image", path: shot, name: "01.png", url: "/review-images/bd/bd-1/01.png" }],
    });
    expect(dto.reviewImages).toEqual([{ path: shot, name: "01.png", url: "/review-images/bd/bd-1/01.png" }]);
  });

  it("is null for a malformed review or an item that is not a review", () => {
    expect(toBoardItemDto(item({ invalid: true }), ROOT).card).toBeNull();
    expect(toBoardItemDto(item(null), ROOT).card).toBeNull();
  });
});
