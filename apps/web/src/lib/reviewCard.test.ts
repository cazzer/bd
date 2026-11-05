// Tests for lib/reviewCard.ts (decision-card-reviews, tasks.md 6.3 and 6.5).

import { describe, expect, it } from "vitest";
import { cardActions, evidenceMarkdown, isCardReview, MAX_INLINE_CHOICES, orderedOptions, recommendedOption, seenFor, splitInlineCode, type CardLike, type CardOption } from "./reviewCard.js";

const A: CardOption = { id: "A", label: "Track function calls, then drop", what: "Turn on tracking.", risk: "Lowest." };
const B: CardOption = { id: "B", label: "Drop on 11-12", what: "Drop now.", risk: "GraphQL callers go unseen." };
const C: CardOption = { id: "C", label: "Don't drop" };
const D: CardOption = { id: "D", label: "Defer", risk: "Nothing changes." };

function card(options: CardOption[], recommend: string | null): CardLike {
  return { question: "Drop v5–v8?", options, recommend };
}

describe("isCardReview", () => {
  it("is false for a legacy review (images and summary only), true with any card key", () => {
    expect(isCardReview({ images: ["/a.png"], pane: null, summary: "Header" })).toBe(false);
    expect(isCardReview({ images: [], pane: "w1:p1", socket: "/s", summary: "x" })).toBe(false);
    expect(isCardReview({ images: [], pane: null, summary: "q", question: "q" })).toBe(true);
    expect(isCardReview({ images: [], pane: null, summary: "", on_accept: ["x"] })).toBe(true);
    expect(isCardReview({ images: [], pane: null, summary: "", attachments: [] })).toBe(true);
    expect(isCardReview({ images: [], pane: null, summary: "", question: undefined })).toBe(false);
  });
});

describe("orderedOptions / recommendedOption", () => {
  it("lists the recommended option first, the rest in the card's order", () => {
    expect(orderedOptions(card([A, B, C], "B"))).toEqual([B, A, C]);
    expect(recommendedOption(card([A, B, C], "B"))).toBe(B);
  });

  it("keeps the card's order when nothing is recommended", () => {
    expect(orderedOptions(card([A, B, C], null))).toEqual([A, B, C]);
    expect(recommendedOption(card([A, B, C], null))).toBeNull();
  });
});

describe("cardActions", () => {
  it("is null for a card without options (and so a legacy review): plain Accept / Request changes", () => {
    expect(cardActions(card([], null))).toBeNull();
  });

  it("accepts the recommended option and offers Choose for each other one, in the card's order", () => {
    expect(cardActions(card([A, B, C], "A"))).toEqual({ accept: A, choices: [B, C], folded: [] });
    expect(cardActions(card([A, B, C], "B"))).toEqual({ accept: B, choices: [A, C], folded: [] });
    expect(cardActions(card([A, B], "B"))).toEqual({ accept: B, choices: [A], folded: [] });
  });

  it(`folds the other options behind "Choose another…" once they are more than ${MAX_INLINE_CHOICES}`, () => {
    expect(MAX_INLINE_CHOICES).toBe(2);
    expect(cardActions(card([A, B, C], "A"))!.folded).toEqual([]);
    expect(cardActions(card([A, B, C, D], "A"))).toEqual({ accept: A, choices: [], folded: [B, C, D] });
    expect(cardActions(card([A, B, C, D], "C"))).toEqual({ accept: C, choices: [], folded: [A, B, D] });
  });

  it("has no Accept when the card recommends nothing, every option a Choose (folded past the threshold)", () => {
    expect(cardActions(card([A, B], null))).toEqual({ accept: null, choices: [A, B], folded: [] });
    expect(cardActions(card([A, B, C], null))).toEqual({ accept: null, choices: [], folded: [A, B, C] });
  });
});

describe("seenFor", () => {
  it("carries the card's question and the option's label, what, and risk exactly", () => {
    expect(seenFor(card([A, B], "A"), B)).toEqual({ question: "Drop v5–v8?", label: "Drop on 11-12", what: "Drop now.", risk: "GraphQL callers go unseen." });
  });

  it("leaves out an absent what or risk rather than sending it empty", () => {
    const seen = seenFor(card([A, C], "A"), C);
    expect(seen).toEqual({ question: "Drop v5–v8?", label: "Don't drop" });
    expect("what" in seen || "risk" in seen).toBe(false);
    expect(seenFor(card([A, D], "A"), D)).toEqual({ question: "Drop v5–v8?", label: "Defer", risk: "Nothing changes." });
  });

  it("keeps an empty-looking what as it is (the normalizer decides what is absent, not the drawer)", () => {
    expect(seenFor({ question: "Q" }, { id: "X", label: "L", what: " " })).toEqual({ question: "Q", label: "L", what: " " });
  });
});

describe("evidenceMarkdown", () => {
  it("is the description, unless blank or only the question again", () => {
    expect(evidenceMarkdown("## Caller audit\n\n| a | b |", "Drop?")).toBe("## Caller audit\n\n| a | b |");
    expect(evidenceMarkdown("", "Drop?")).toBeNull();
    expect(evidenceMarkdown("  \n", "Drop?")).toBeNull();
    expect(evidenceMarkdown("Drop?\n", "Drop?")).toBeNull();
  });
});

describe("splitInlineCode", () => {
  it("splits backtick spans into code, the rest into text", () => {
    expect(splitInlineCode("Turn on `track_functions=all` now, then `go=true`.")).toEqual([
      { text: "Turn on ", code: false },
      { text: "track_functions=all", code: true },
      { text: " now, then ", code: false },
      { text: "go=true", code: true },
      { text: ".", code: false },
    ]);
  });

  it("keeps plain text, an unpaired backtick, and an empty span as text", () => {
    expect(splitInlineCode("plain")).toEqual([{ text: "plain", code: false }]);
    expect(splitInlineCode("a ` b")).toEqual([{ text: "a ` b", code: false }]);
    expect(splitInlineCode("a `` b")).toEqual([{ text: "a `` b", code: false }]);
    expect(splitInlineCode("")).toEqual([]);
    expect(splitInlineCode("`x`")).toEqual([{ text: "x", code: true }]);
  });
});
