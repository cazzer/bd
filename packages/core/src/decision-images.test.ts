import { describe, expect, it } from "vitest";
import { parseRelayPayload } from "./relay.js";
import { decisionCommentImagesBlock, decisionImagePathPattern, decisionMessageBudget, isDecisionImagePath, MAX_DECISION_IMAGE_BYTES, MAX_DECISION_IMAGES } from "./reviews.js";

describe("decision image paths", () => {
  it("accepts an image in a run under the decision's own item", () => {
    expect(isDecisionImagePath("bd/bd-1/d-20261117120000-ab12/01-shot.png", "bd", "bd-1")).toBe(true);
    expect(isDecisionImagePath("bd/bd-1/r1/02-a.jpeg", "bd", "bd-1")).toBe(true);
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) expect(isDecisionImagePath(`bd/bd-1/r/a.${ext}`, "bd", "bd-1")).toBe(true);
  });

  it("refuses another item, another project, traversal, a video, an absolute path, and extra segments", () => {
    for (const p of [
      "bd/bd-2/r1/01-a.png",
      "other/bd-1/r1/01-a.png",
      "bd/bd-1/../r1/01-a.png",
      "bd/bd-1/r1/../01-a.png",
      "bd/bd-1/r1/01-a.mp4",
      "/bd/bd-1/r1/01-a.png",
      "bd/bd-1/r1/sub/01-a.png",
      "bd/bd-1/r1/.owner.png",
      "bd/bd-1/r1/01-a.PNG",
      "bd/bd-1x/r1/01-a.png",
    ]) {
      expect(isDecisionImagePath(p, "bd", "bd-1"), p).toBe(false);
    }
    expect(isDecisionImagePath(42, "bd", "bd-1")).toBe(false);
  });

  it("treats a dot in the project or item literally", () => {
    expect(decisionImagePathPattern("a.b", "x.1").test("a.b/x.1/r/n.png")).toBe(true);
    expect(decisionImagePathPattern("a.b", "x.1").test("aXb/x.1/r/n.png")).toBe(false);
  });

  it("formats the comment block", () => {
    expect(decisionCommentImagesBlock([])).toBe("");
    expect(decisionCommentImagesBlock(["bd/bd-1/r/01-a.png", "bd/bd-1/r/02-b.png"])).toBe("\n\nImages:\nbd/bd-1/r/01-a.png\nbd/bd-1/r/02-b.png");
  });

  it("caps count and size", () => {
    expect(MAX_DECISION_IMAGES).toBe(6);
    expect(MAX_DECISION_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("review_decision payload images", () => {
  const base = { project_key: "bd", cwd: "/Users/test/bd", issue_id: "bd-1", decision: "changes", message: "Smoke is too dark" };

  it("parses a payload without images unchanged, and one with images", () => {
    expect(parseRelayPayload("review_decision", base)).toEqual(base);
    const images = ["bd/bd-1/d-20261117120000-ab12/01-a.png", "bd/bd-1/d-20261117120000-ab12/02-b.webp"];
    expect(parseRelayPayload("review_decision", { ...base, images }).images).toEqual(images);
  });

  it("refuses another item's image naming the field", () => {
    expect(() => parseRelayPayload("review_decision", { ...base, images: ["bd/bd-2/r/01-a.png"] })).toThrow(/payload\.images\.0/);
  });

  it("refuses more than six images, an empty list, and a message that no longer fits beside them", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `bd/bd-1/r/0${i}-a.png`);
    expect(() => parseRelayPayload("review_decision", { ...base, images: seven })).toThrow(/payload\.images/);
    expect(() => parseRelayPayload("review_decision", { ...base, images: [] })).toThrow(/payload\.images/);
    const images = ["bd/bd-1/r/01-a.png"];
    const tooLong = "x".repeat(decisionMessageBudget(images) + 1);
    expect(() => parseRelayPayload("review_decision", { ...base, message: tooLong, images })).toThrow(/payload\.message/);
    expect(parseRelayPayload("review_decision", { ...base, message: "x".repeat(decisionMessageBudget(images)), images }).images).toEqual(images);
  });
});
