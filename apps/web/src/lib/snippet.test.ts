// Regression test for the stored-XSS fix this parser exists to hold in
// place (bd-hmd.3 review; moved here in bd-hmd.4 — see this module's
// header). The property under test: every character outside the literal
// `[[`/`]]` delimiters — `<`/`>` included — survives into a segment's
// `text` completely unparsed, so a call site that renders `text` as text
// (React JSX, or `.textContent`) never executes it as markup.

import { describe, expect, it } from "vitest";
import { parseSnippetSegments } from "./snippet.js";

describe("parseSnippetSegments", () => {
  it("splits highlighted and plain text around [[ ]] delimiters", () => {
    expect(parseSnippetSegments("before [[hit]] after")).toEqual([
      { text: "before ", highlighted: false },
      { text: "hit", highlighted: true },
      { text: " after", highlighted: false },
    ]);
  });

  it("handles multiple highlighted spans", () => {
    expect(parseSnippetSegments("[[a]] mid [[b]]")).toEqual([
      { text: "a", highlighted: true },
      { text: " mid ", highlighted: false },
      { text: "b", highlighted: true },
    ]);
  });

  it("returns the whole snippet as one unhighlighted segment when there are no delimiters", () => {
    expect(parseSnippetSegments("plain text")).toEqual([{ text: "plain text", highlighted: false }]);
  });

  it("passes markup characters through as literal text, never interpreting them", () => {
    const malicious = "xsstest [[<img src=x onerror=alert(1)>]] rest";
    const segments = parseSnippetSegments(malicious);
    // The offending markup lands inside a highlighted segment's `text` —
    // untouched, unparsed — not dropped, not escaped-and-reinterpreted,
    // and critically not split into anything that looks like a tag.
    expect(segments).toEqual([
      { text: "xsstest ", highlighted: false },
      { text: "<img src=x onerror=alert(1)>", highlighted: true },
      { text: " rest", highlighted: false },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseSnippetSegments("")).toEqual([]);
  });
});
