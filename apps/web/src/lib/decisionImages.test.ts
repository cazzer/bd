import { DECISION_IMAGE_TYPES as CORE_TYPES, decisionCommentImagesBlock, decisionMessageBudget, MAX_DECISION_IMAGE_BYTES as CORE_BYTES, MAX_DECISION_IMAGES as CORE_MAX, MAX_REVIEW_DECISION_MESSAGE_LENGTH } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import {
  admitDecisionImages,
  charactersToCut,
  DECISION_IMAGE_TYPES,
  decisionImageName,
  decisionRunName,
  imagesBlockLength,
  MAX_DECISION_IMAGE_BYTES,
  MAX_DECISION_IMAGES,
  MAX_DECISION_MESSAGE_LENGTH,
} from "./decisionImages.js";

describe("decision image limits", () => {
  it("mirror core's", () => {
    expect(MAX_DECISION_IMAGES).toBe(CORE_MAX);
    expect(MAX_DECISION_IMAGE_BYTES).toBe(CORE_BYTES);
    expect(DECISION_IMAGE_TYPES).toEqual(CORE_TYPES);
    expect(MAX_DECISION_MESSAGE_LENGTH).toBe(MAX_REVIEW_DECISION_MESSAGE_LENGTH);
    const paths = ["p/i/r/01-a.png", "p/i/r/02-b.png"];
    expect(imagesBlockLength(paths)).toBe(decisionCommentImagesBlock(paths).length);
    expect(charactersToCut("x".repeat(decisionMessageBudget(paths) + 3), paths)).toBe(3);
    expect(charactersToCut("x".repeat(decisionMessageBudget(paths)), paths)).toBe(0);
  });
});

describe("admitDecisionImages", () => {
  const f = (name: string, type: string, size = 10) => ({ name, type, size });
  it("keeps images in order and names each refused file", () => {
    const { accepted, refused } = admitDecisionImages(4, [f("a.png", "image/png"), f("b.pdf", "application/pdf"), f("big.png", "image/png", 11 * 2 ** 20), f("c.webp", "image/webp"), f("d.gif", "image/gif")]);
    expect(accepted.map((a) => a.name)).toEqual(["a.png", "c.webp"]);
    expect(refused).toEqual([
      "b.pdf is not an image a decision can carry (PNG, JPEG, GIF, or WebP).",
      "big.png is over 10 MB.",
      "d.gif was not added: a decision carries at most 6 images.",
    ]);
  });
  it("takes an image with no type by its extension", () => {
    expect(admitDecisionImages(0, [f("x.JPEG", "")]).accepted).toHaveLength(1);
    expect(admitDecisionImages(0, [f("x.svg", "image/svg+xml")]).accepted).toHaveLength(0);
  });
});

describe("names", () => {
  it("runs are d-<UTC stamp>-<4 base36> and names NN-<slug>.<ext>", () => {
    expect(decisionRunName(new Date("2026-11-17T12:03:04.567Z"), () => 0)).toBe("d-20261117120304-aaaa");
    expect(decisionImageName(0, { name: "Screen Shot 2026-11-17 at 12.03.png", type: "image/png" })).toBe("01-screen-shot-2026-11-17-at-12-03.png");
    expect(decisionImageName(9, { name: "image.jpeg", type: "image/jpeg" })).toBe("10-image.jpg");
    expect(decisionImageName(1, { name: "", type: "image/png" })).toBe("02-screenshot.png");
    expect(decisionImageName(2, { name: "日本.webp", type: "image/webp" })).toBe("03-screenshot.webp");
  });
});
