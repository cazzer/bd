// Tests for lib/firstParagraph.ts (bd-e9n). Each case maps onto tasks.md
// group 3.3's required list (single paragraph, multiple paragraphs,
// leading blank lines, no paragraph break at all) plus the additional
// cases the ticket names (heading-first, fenced-code-first, list-first,
// blank-line-separated paragraphs, CRLF, empty content).

import { describe, expect, it } from "vitest";
import { firstParagraph } from "./firstParagraph.js";

describe("firstParagraph — plain paragraphs", () => {
  it("returns the whole content when it's a single paragraph with no break", () => {
    expect(firstParagraph("Just one paragraph of text.")).toBe("Just one paragraph of text.");
  });

  it("returns only the first of several blank-line-separated paragraphs", () => {
    const markdown = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    expect(firstParagraph(markdown)).toBe("First paragraph.");
  });

  it("joins a multi-line paragraph block (no blank line inside it) into one excerpt", () => {
    const markdown = "Line one of the paragraph.\nLine two of the paragraph.\n\nA second paragraph.";
    expect(firstParagraph(markdown)).toBe("Line one of the paragraph.\nLine two of the paragraph.");
  });

  it("skips leading blank lines to find the first real paragraph", () => {
    const markdown = "\n\n\nActual first paragraph.";
    expect(firstParagraph(markdown)).toBe("Actual first paragraph.");
  });

  it("leaves inline markdown syntax untouched", () => {
    expect(firstParagraph("A paragraph with **bold** and _italic_ and a [link](https://example.com).")).toBe(
      "A paragraph with **bold** and _italic_ and a [link](https://example.com).",
    );
  });
});

describe("firstParagraph — skips excluded block types to find the real paragraph", () => {
  it("skips a leading heading", () => {
    const markdown = "# Title\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips a leading fenced code block, including its internal blank lines", () => {
    const markdown = "```\ncode line 1\n\ncode line 2\n```\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips a leading list", () => {
    const markdown = "- item one\n- item two\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips a leading blockquote", () => {
    const markdown = "> a quoted line\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips a leading table row", () => {
    const markdown = "| a | b |\n| - | - |\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips a leading raw HTML line", () => {
    const markdown = "<div>raw html</div>\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });

  it("skips multiple excluded blocks in a row before finding the paragraph", () => {
    const markdown = "# Title\n\n- a list\n- another item\n\n> a quote\n\nThe real first paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.");
  });
});

describe("firstParagraph — fallbacks", () => {
  it("falls back to the first non-empty line when nothing qualifies as a paragraph", () => {
    expect(firstParagraph("# Just a heading, nothing else")).toBe("# Just a heading, nothing else");
  });

  it("returns an empty string for empty content", () => {
    expect(firstParagraph("")).toBe("");
  });

  it("returns an empty string for content that is only whitespace/blank lines", () => {
    expect(firstParagraph("\n\n   \n\n")).toBe("");
  });
});

describe("firstParagraph — line endings", () => {
  it("handles CRLF line endings the same as LF", () => {
    const markdown = "# Title\r\n\r\nThe real first paragraph.\r\nStill the same paragraph.\r\n\r\nSecond paragraph.";
    expect(firstParagraph(markdown)).toBe("The real first paragraph.\nStill the same paragraph.");
  });
});
