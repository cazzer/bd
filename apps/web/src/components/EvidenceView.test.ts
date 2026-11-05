// @vitest-environment jsdom
//
// EvidenceView, DiffBlock, and MermaidBlock in a DOM (decision-card-reviews
// task 5.4). mermaid itself needs a layout engine jsdom lacks, so it is
// mocked: these tests check what the app does with mermaid — how it is
// configured, that it is loaded lazily, and that its SVG reaches the page only
// as an image — not mermaid's drawing. The mock deliberately returns hostile
// SVG, so the "no executable markup" assertions cover whatever mermaid emits.
// Selecting text inside a drawn block (ProseMirror must not take the mouse) and
// the Lightbox (a modal <dialog>) need a real browser; they were checked there.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** SVG with every character a data URL must encode: `#` would end the URL at a fragment, `%` would start an escape, quotes would end the attribute. */
const SPECIAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 40"><g viewBox="0 0 999 999"><text fill="#e2e8f0" font-family='a "b"'>100% é → ok</text></g></svg>`;

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  slow: null as null | ((svg: string) => void),
  render: vi.fn(async (id: string, source: string): Promise<{ svg: string }> => {
    if (source.includes("BROKEN")) throw new Error("Parse error on line 2: unexpected token");
    if (source.includes("SPECIAL")) return { svg: SPECIAL_SVG };
    // A lone surrogate makes encodeURIComponent throw, after mermaid succeeded.
    if (source.includes("LONE_SURROGATE")) return { svg: "<svg viewBox=\"0 0 1 1\">\uD800</svg>" };
    if (source.includes("SLOW")) return new Promise((resolve) => (mermaidMock.slow = (svg) => resolve({ svg })));
    return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><script>alert(1)</script><a href="javascript:alert(2)"><text onclick="alert(3)">${source}</text></a></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

const { EvidenceView } = await import("./EvidenceView.js");
const { DiffBlock } = await import("./DiffBlock.js");
const { MermaidBlock } = await import("./MermaidBlock.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => root.render(element));
}

async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = find();
    if (found) return found;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  throw new Error(`timed out waiting for ${what}; DOM: ${container.innerHTML.slice(0, 2000)}`);
}

/** Every way markup in the DOM could run code: script-like elements, inline SVG, on* handlers, javascript: URLs. */
function executableMarkup(el: Element): string[] {
  const found: string[] = [];
  for (const node of el.querySelectorAll("*")) {
    const tag = node.tagName.toLowerCase();
    if (["script", "iframe", "object", "embed", "svg", "foreignobject"].includes(tag)) found.push(`<${tag}>`);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name)) found.push(`${tag}[${attr.name}]`);
      if (/^\s*javascript:/i.test(attr.value)) found.push(`${tag}[${attr.name}=${attr.value}]`);
    }
  }
  return found;
}

/** The container's text a person sees: `hidden` subtrees (ProseMirror's own copy of a drawn block's text) left out. */
function shownText(): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll("[hidden]")) el.remove();
  return clone.textContent ?? "";
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

const shloBody = readFileSync(join(import.meta.dirname, "../../../../fixtures/review-cards/shlo-k54.4.1.1.md"), "utf8").split(/^---$/m).slice(2).join("---");

describe("EvidenceView", () => {
  test("GFM tables render as tables (the shlo fixture's two tables), each in a focusable region", async () => {
    await render(createElement(EvidenceView, { markdown: shloBody }));
    const tables = await waitFor(() => {
      const t = container.querySelectorAll("table");
      return t.length > 0 ? t : null;
    }, "tables");
    expect(tables).toHaveLength(2);
    const headers = [...tables[0]!.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toEqual(["Caller", "Uses", "Since"]);
    expect(tables[0]!.querySelectorAll("tr")).toHaveLength(6);
    expect(tables[1]!.querySelector("td strong")?.textContent).toBe("374 ms");
    for (const table of tables) {
      const region = table.parentElement!;
      expect([region.className, region.getAttribute("role"), region.getAttribute("tabindex"), region.getAttribute("aria-label")]).toEqual(["tableWrapper", "region", "0", "Table"]);
    }
  });

  test("headings render two levels down, capped at h6", async () => {
    await render(createElement(EvidenceView, { markdown: "# One\n\n## Two\n\n#### Four\n\n###### Six" }));
    await waitFor(() => container.querySelector("h3"), "a heading");
    expect([...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => `${h.tagName}:${h.textContent}`)).toEqual(["H3:One", "H4:Two", "H6:Four", "H6:Six"]);
  });

  test("a diff fence marks added and removed lines, with screen-reader prefixes", async () => {
    await render(createElement(EvidenceView, { markdown: "Before\n\n```diff\n@@ -1,2 +1,2 @@\n-old line\n+new line\n same\n```\n" }));
    const added = await waitFor(() => container.querySelector('[data-diff-line="added"]'), "an added line");
    const removed = container.querySelector('[data-diff-line="removed"]')!;
    expect(added.textContent).toBe("added: +new line");
    expect(added.querySelector(".sr-only")?.textContent).toBe("added: ");
    expect(removed.textContent).toBe("removed: -old line");
    expect(container.querySelector('[data-diff-line="hunk"]')?.textContent).toBe("@@ -1,2 +1,2 @@");
    expect(container.querySelector('[data-diff-line="context"]')?.textContent).toBe(" same");
    expect(occurrences(shownText(), "+new line")).toBe(1);
  });

  test("another fence stays a plain code block", async () => {
    await render(createElement(EvidenceView, { markdown: "```sql\nselect 1;\n```\n" }));
    const pre = await waitFor(() => container.querySelector("pre"), "a pre");
    expect(pre.textContent).toBe("select 1;");
    expect(occurrences(shownText(), "select 1;")).toBe(1);
    expect(container.querySelector("[data-diff-line]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("a mermaid fence mounts the lazy diagram, drawn only as an image named by its kind, with its source as text", async () => {
    const source = "erDiagram\n  NODE ||--o{ EDGE : \"source of\"";
    await render(createElement(EvidenceView, { markdown: `Intro\n\n\`\`\`mermaid\n${source}\n\`\`\`\n` }));
    const img = await waitFor(() => container.querySelector("img"), "the diagram image");
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.stringMatching(/^evidence-mermaid-\d+$/), source);
    expect(img.getAttribute("alt")).toBe("Entity-relationship diagram");
    expect(img.closest("button")?.getAttribute("aria-label")).toBe("Enlarge Entity-relationship diagram");
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(img.getAttribute("width")).toBe("320");
    expect(img.getAttribute("height")).toBe("180");
    // Once, in the "Diagram source" disclosure; ProseMirror's own copy is hidden.
    expect(occurrences(shownText(), "erDiagram")).toBe(1);
    expect(container.querySelector("details")?.textContent).toBe(`Diagram source${source}`);
    expect(executableMarkup(container)).toEqual([]);
  });

  test("evidence with a script, an img onerror, a javascript: link, and a hostile diagram yields no executable markup", async () => {
    const markdown = [
      "<script>alert('evidence')</script>",
      "",
      '<img src="x" onerror="alert(1)">',
      "",
      "[click me](javascript:alert(2))",
      "",
      "| a | b |",
      "| --- | --- |",
      '| <img src=x onerror="alert(3)"> | <a href="javascript:alert(4)">x</a> |',
      "",
      "```mermaid",
      'flowchart LR',
      '  A["<img src=x onerror=alert(5)>"] --> B["<a href=javascript:alert(6)>go</a>"]',
      '  click A "javascript:alert(7)"',
      "```",
    ].join("\n");
    await render(createElement(EvidenceView, { markdown }));
    const img = await waitFor(() => container.querySelector("img"), "the diagram image");
    expect(container.querySelector("table")).not.toBeNull();
    expect(executableMarkup(container)).toEqual([]);
    // The only <img> is the diagram, and the hostile SVG mermaid returned lives only inside its data URL.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain("<script>alert(1)</script>");
    expect(container.innerHTML).not.toContain("<script");
  });
});

describe("MermaidBlock", () => {
  test("mermaid is initialized once, strict, without HTML labels, never on load, and htmlLabels cannot be re-enabled", async () => {
    // A fresh module graph, so MermaidDiagram's once-only initialization has not run yet whatever ran before this test.
    vi.resetModules();
    mermaidMock.initialize.mockClear();
    const { MermaidBlock: FreshMermaidBlock } = await import("./MermaidBlock.js");
    await render(createElement("div", null, createElement(FreshMermaidBlock, { source: "graph TD; A-->B", caption: "First" }), createElement(FreshMermaidBlock, { source: "graph TD; C-->D" })));
    await waitFor(() => (container.querySelectorAll("img").length === 2 ? true : null), "two diagrams");
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: "strict", htmlLabels: false }));
    // mermaid's own secure keys, plus htmlLabels: a directive or frontmatter in the source cannot override any of them.
    expect(mermaidMock.initialize.mock.calls[0]![0].secure).toEqual(["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels"]);
    // The caption is the figure's, not the image's.
    expect(container.querySelector("figcaption")?.textContent).toBe("First");
    expect([...container.querySelectorAll("img")].map((img) => img.alt)).toEqual(["Flowchart", "Flowchart"]);
  });

  test("the data URL carries the SVG exactly: #, %, quotes, and non-ASCII are encoded", async () => {
    await render(createElement(MermaidBlock, { source: "graph TD; SPECIAL" }));
    const img = await waitFor(() => container.querySelector("img"), "the diagram image");
    const src = img.getAttribute("src")!;
    const prefix = "data:image/svg+xml;charset=utf-8,";
    expect(src.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(SPECIAL_SVG);
    expect(src).not.toContain("#");
    expect(src).not.toContain('"');
    // The root <svg>'s viewBox, not the nested one.
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["90", "40"]);
  });

  test("one status region says it is drawing until the diagram is drawn", async () => {
    await render(createElement(MermaidBlock, { source: "graph TD; SLOW" }));
    await waitFor(() => mermaidMock.slow, "the render to start");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Drawing diagram…");
    await act(async () => mermaidMock.slow!('<svg viewBox="0 0 10 10"></svg>'));
    await waitFor(() => container.querySelector("img"), "the diagram image");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    mermaidMock.slow = null;
  });

  test("a failure after mermaid succeeded still shows the source and the error, not a status stuck on drawing", async () => {
    await render(createElement(MermaidBlock, { source: "graph TD; LONE_SURROGATE" }));
    const reason = await waitFor(() => [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("didn't render")), "the error");
    expect(reason.parentElement?.textContent).toContain("graph TD; LONE_SURROGATE");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  test("a diagram that does not parse shows its source and the error, and the rest of the evidence renders", async () => {
    const source = "graph TD\n  BROKEN -->";
    await render(createElement(EvidenceView, { markdown: `# Heading\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter the diagram.` }));
    const reason = await waitFor(() => [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("didn't render")), "the error");
    expect(reason.textContent).toContain("Parse error on line 2: unexpected token");
    expect(occurrences(shownText(), source)).toBe(1);
    expect(reason.parentElement?.textContent).toContain(source);
    expect(container.querySelector("h3")?.textContent).toBe("Heading");
    expect(container.textContent).toContain("After the diagram.");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("DiffBlock", () => {
  test("renders the source as text under its caption, never as markup", async () => {
    await render(createElement(DiffBlock, { source: "+<img src=x onerror=alert(1)>\n-<script>x</script>", caption: "Migrations" }));
    expect(container.querySelector("figcaption")?.textContent).toBe("Migrations");
    expect(container.querySelector('[data-diff-line="added"]')?.textContent).toBe("added: +<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(executableMarkup(container)).toEqual([]);
  });

  const longDiff = ["@@ -1,20 +1,20 @@", ...Array.from({ length: 20 }, (_, i) => `-old ${i}`), ...Array.from({ length: 20 }, (_, i) => `+new ${i}`)].join("\n");

  test("a long diff starts clipped to 24 lines, with a control showing all of them and their counts", async () => {
    await render(createElement(DiffBlock, { source: longDiff }));
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(24);
    const toggle = container.querySelector("button")!;
    expect(toggle.textContent).toBe("Show all 41 lines (+20 −20)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(41);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer lines");
  });

  test("maxLines={Infinity} and fill never clip; fill makes the lines a focusable scrolling region", async () => {
    await render(createElement("div", null, createElement(DiffBlock, { source: longDiff, maxLines: Infinity }), createElement(DiffBlock, { source: longDiff, fill: true, caption: "Migration" })));
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(82);
    expect(container.querySelector("button")).toBeNull();
    const region = container.querySelector('[role="region"]')!;
    expect([region.getAttribute("tabindex"), region.getAttribute("aria-label")]).toEqual(["0", "Migration"]);
  });

  test("each file after the first starts below a rule", async () => {
    await render(createElement(DiffBlock, { source: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d" }));
    const files = [...container.querySelectorAll('[data-diff-line="file"]')];
    expect(files.map((f) => f.classList.contains("border-t"))).toEqual([false, true]);
  });
});
