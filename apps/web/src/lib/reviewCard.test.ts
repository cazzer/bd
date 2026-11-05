// Tests for lib/reviewCard.ts (decision-card-reviews, tasks.md 6.3 and 6.5).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapBeadsIssueToNode } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import {
  CARD_MOVED_TEXT,
  cardActions,
  chosenOption,
  describeChosen,
  evidenceMarkdown,
  foldLabel,
  isCardMovedRefusal,
  MAX_INLINE_CHOICES,
  REVIEW_ACCEPTANCE,
  orderedOptions,
  recommendedOption,
  seenFor,
  splitInlineCode,
  type CardLike,
  type CardOption,
} from "./reviewCard.js";

const A: CardOption = { id: "A", label: "Track function calls, then drop", what: "Turn on tracking.", risk: "Lowest." };
const B: CardOption = { id: "B", label: "Drop on 11-12", what: "Drop now.", risk: "GraphQL callers go unseen." };
const C: CardOption = { id: "C", label: "Don't drop" };
const D: CardOption = { id: "D", label: "Defer", risk: "Nothing changes." };

function card(options: CardOption[], recommend: string | null): CardLike {
  return { question: "Drop v5–v8?", options, recommend };
}

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

  it("has no Accept when the card recommends nothing, so one more Choose fits inline before the fold", () => {
    expect(cardActions(card([A, B], null))).toEqual({ accept: null, choices: [A, B], folded: [] });
    expect(cardActions(card([A, B, C], null))).toEqual({ accept: null, choices: [A, B, C], folded: [] });
    expect(cardActions(card([A, B, C, D], null))).toEqual({ accept: null, choices: [], folded: [A, B, C, D] });
  });

  it("labels the fold by whether there is a recommendation beside it", () => {
    expect(foldLabel(cardActions(card([A, B, C, D], "A"))!)).toBe("Choose another…");
    expect(foldLabel(cardActions(card([A, B, C, D], null))!)).toBe("Choose an option…");
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

describe("chosenOption / describeChosen", () => {
  it("announces the recommendation as accepted and any other option as chosen against it", () => {
    expect(chosenOption(card([A, B], "A"), A)).toEqual({ id: "A", recommended: true });
    expect(chosenOption(card([A, B], "A"), B)).toEqual({ id: "B", recommended: false });
    expect(chosenOption(card([A, B], null), A)).toEqual({ id: "A", recommended: false });
    expect(describeChosen({ id: "A", recommended: true })).toBe("Accepted A");
    expect(describeChosen({ id: "B", recommended: false })).toBe("Chose B (not the recommendation)");
  });
});

describe("isCardMovedRefusal", () => {
  it("is true for the refusals that mean the card moved, false for the rest (wording pinned against the writer in cardRoundtrip.test.ts)", () => {
    expect(isCardMovedRefusal('Review "x" changed since it was opened (option B or its question differs); reopen it. Nothing was written.')).toBe(true);
    expect(isCardMovedRefusal('Review "x" does not offer option "Z" (it offers A, B); nothing was written.')).toBe(true);
    expect(isCardMovedRefusal('Review "x" carries options the board cannot read (its card is invalid in the tracker), so it cannot be accepted here.')).toBe(true);
    expect(isCardMovedRefusal('Review "x" is already closed.')).toBe(false);
    expect(isCardMovedRefusal("The server is read-only (BRAIN_READ_ONLY); review decisions are refused.")).toBe(false);
    expect(CARD_MOVED_TEXT).toContain("Nothing was written.");
  });
});

describe("evidenceMarkdown", () => {
  it("is the description, unless blank or only the question again", () => {
    expect(evidenceMarkdown("## Caller audit\n\n| a | b |", "Drop?")).toBe("## Caller audit\n\n| a | b |");
    expect(evidenceMarkdown("", "Drop?")).toBeNull();
    expect(evidenceMarkdown("  \n", "Drop?")).toBeNull();
    expect(evidenceMarkdown("Drop?\n", "Drop?")).toBeNull();
  });

  // The CLI is untyped .mjs outside this package; a non-literal specifier keeps tsc from resolving it.
  const CLI_LIB = join(import.meta.dirname, "..", "..", "..", "..", "bin", "review-request-lib.mjs");
  const cli = () => import(CLI_LIB) as Promise<{ REVIEW_ACCEPTANCE: string; splitCard: (text: string) => { body: string } | null }>;
  /** A review bead's node content exactly as a beads load stores it: the real mapper, the CLI's acceptance. */
  const reviewContent = (description: string) =>
    mapBeadsIssueToNode({ id: "bd-x.1", title: "Review: x", status: "open", priority: 2, description, acceptance_criteria: REVIEW_ACCEPTANCE }).content ?? "";

  it("uses the acceptance text review-request files", async () => {
    expect((await cli()).REVIEW_ACCEPTANCE).toBe(REVIEW_ACCEPTANCE);
  });

  it("is exactly the card body when the beads mapper appended the review's acceptance section", async () => {
    const card = (await cli()).splitCard(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "review-cards", "shlo-k54.4.1.1.md"), "utf8"));
    expect(card).not.toBeNull();
    const content = reviewContent(card!.body);
    expect(content).not.toBe(card!.body);
    expect(evidenceMarkdown(content, "Drop?")).toBe(card!.body);
  });

  it("strips only that exact trailing section", () => {
    const mid = `Before.\n\n## Acceptance criteria\n\n${REVIEW_ACCEPTANCE}\n\nAfter.`;
    expect(evidenceMarkdown(mid, "Drop?")).toBe(mid);
    const other = "Body.\n\n## Acceptance criteria\n\nShip it when green";
    expect(evidenceMarkdown(other, "Drop?")).toBe(other);
    const mention = "The Acceptance criteria field says Accepted from the breakdown board.";
    expect(evidenceMarkdown(mention, "Drop?")).toBe(mention);
  });

  it("keeps the blank and question-only rules after stripping", () => {
    expect(evidenceMarkdown(reviewContent(""), "Drop?")).toBeNull();
    expect(evidenceMarkdown(reviewContent("Drop?"), "Drop?")).toBeNull();
    expect(evidenceMarkdown(reviewContent("Evidence."), "Drop?")).toBe("Evidence.");
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
