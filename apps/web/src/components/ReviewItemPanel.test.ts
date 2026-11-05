// @vitest-environment jsdom
//
// ReviewItemPanel with a decision card (decision-card-reviews, tasks.md 6.1,
// 6.3, 6.5). The item is the real `boardItem` answer for the fixture cards —
// normalized by core and shaped by server/dto.ts, as the server serves it —
// and the tRPC client is mocked, so these tests check what the panel shows
// and what it sends: the card's sections in spec order, the option actions
// and the `seen` they send, the fold, the shortcuts, refusals in the
// server's words, and a legacy review shown and decided as before.
// EvidenceView (tiptap) and MermaidBlock (mermaid) are stubbed; they have
// their own tests (EvidenceView.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewMetadata, type BoardItem } from "@breakdown/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toBoardItemDto } from "../../server/dto.js";
import type { PanelDecisions } from "./ReviewItemPanel.js";

const trpcMock = vi.hoisted(() => ({
  boardItem: { query: vi.fn() },
  reviewDecision: { mutate: vi.fn() },
}));
vi.mock("../trpc.js", () => ({ trpc: trpcMock, HttpStatusError: class HttpStatusError extends Error {} }));
vi.mock("./EvidenceView.js", async () => {
  const { createElement: h } = await import("react");
  return { EvidenceView: ({ markdown }: { markdown: string }) => h("div", { "data-stub": "evidence" }, markdown) };
});
vi.mock("./MermaidBlock.js", async () => {
  const { createElement: h } = await import("react");
  return { MermaidBlock: ({ caption }: { source: string; caption?: string }) => h("figure", { "data-stub": "mermaid" }, caption ?? "Diagram") };
});

const { ReviewItemPanel } = await import("./ReviewItemPanel.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "review-cards");
const ROOT = "/home/me/.local/share/breakdown/reviews";

function fixtureReview(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8").replaceAll("/REVIEW_ROOT", ROOT));
}

function boardItem(rawReview: unknown, content = ""): unknown {
  const item: BoardItem = {
    id: "00000000-0000-0000-0000-000000000001",
    externalId: "shlo-k54.4.1.1",
    sourceSystem: "beads",
    project: "shlo",
    title: "Review: Retire omni_search v5–v8",
    content,
    status: "open",
    priority: 1,
    issueType: "task",
    assignee: null,
    labels: ["review"],
    closedAt: null,
    closedReason: null,
    updatedAt: new Date("2026-11-05T12:00:00.000Z"),
    isReview: true,
    review: normalizeReviewMetadata(rawReview),
    comments: [],
    parent: null,
  };
  return JSON.parse(JSON.stringify(toBoardItemDto(item, ROOT)));
}

const SHLO = fixtureReview("shlo-k54.4.1.1") as { question: string; options: Array<{ id: string; label: string; what: string; risk: string }> };
const EVIDENCE = "## Caller audit\n\n| Caller | Uses |\n| --- | --- |\n| web-app | v9 |";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  trpcMock.boardItem.query.mockReset();
  trpcMock.reviewDecision.mutate.mockReset();
  trpcMock.reviewDecision.mutate.mockResolvedValue({ ok: true, decision: "accept", item: "shlo-k54.4.1.1", written: ["comment", "close"], notified: { ok: true, pane: "w1:p1" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(item: unknown, decisions?: PanelDecisions) {
  trpcMock.boardItem.query.mockResolvedValue({ item });
  await act(async () => {
    root.render(
      createElement(ReviewItemPanel, {
        project: "shlo",
        item: "shlo-k54.4.1.1",
        boardLoaded: true,
        boardVersion: 0,
        initialDraft: "",
        onDraftChange: () => {},
        onDecided: () => {},
        onProjectConfirmed: () => {},
        onEscape: () => {},
        titleId: "t",
        ...(decisions ? { decisions } : {}),
      }),
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function button(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.startsWith(text));
  if (!found) throw new Error(`no button starting "${text}" in: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
}

function sectionTitles(): string[] {
  return [...container.querySelectorAll("h3")].map((h) => h.textContent!.replace(/[▸▾]|Show|Hide/g, "").trim());
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

function typeMessage(text: string) {
  const box = container.querySelector("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("a card with options", () => {
  test("shows question, options (recommended first, with its risk), on-accept, attachments, evidence, thread — in that order", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1"), EVIDENCE));
    expect(sectionTitles()).toEqual(["Question", "Options · 3", "On accept · 3 steps", "Diffs · 1", "Evidence", "Thread · 0"]);
    expect(container.textContent).not.toContain("Summary");
    const items = [...container.querySelectorAll("ol")[0]!.querySelectorAll("li")];
    expect(items.map((li) => li.querySelector(".sr-only")?.textContent)).toEqual(["Option A: ", "Option B: ", "Option C: "]);
    expect(items[0]!.textContent).toContain("Recommended");
    expect(items[0]!.textContent).toContain(SHLO.options[0]!.risk);
    expect(items[0]!.querySelector("code")?.textContent).toBe("track_functions=all");
    expect(items[1]!.textContent).not.toContain("Recommended");
  });

  test("starts the evidence collapsed behind a control that expands it in place", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1"), EVIDENCE));
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded][aria-controls]")!;
    expect(toggle.textContent).toContain("Evidence");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-stub=evidence]")).toBeNull();
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-stub=evidence]")?.textContent).toBe(EVIDENCE);
    const section = toggle.closest("section")!;
    expect(container.querySelector(`#${CSS.escape(section.getAttribute("aria-labelledby")!)}`)?.textContent).toContain("Evidence");
  });

  test("offers Accept <recommended>, Choose <other> per option, and Request changes", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1"), EVIDENCE));
    const footer = buttons().filter((b) => /^(Accept|Choose|B|C|Request)/.test(b.textContent ?? ""));
    expect(footer.map((b) => b.textContent)).toEqual([
      "Accept Track function calls, then drop (option A, recommended)",
      "BChoose Drop on 11-12 on current evidence (option B)",
      "CChoose Don't drop (option C)",
      "Request changes",
    ]);
  });

  test("Choose sends the option id and what the person saw of it", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1"), EVIDENCE));
    typeMessage("skip the tracking migration");
    await click(button("BChoose"));
    const b = SHLO.options[1]!;
    expect(trpcMock.reviewDecision.mutate).toHaveBeenCalledWith({
      project: "shlo",
      item: "shlo-k54.4.1.1",
      decision: "accept",
      message: "skip the tracking migration",
      option: "B",
      seen: { question: SHLO.question, label: b.label, what: b.what, risk: b.risk },
    });
    expect(container.textContent).toContain("Accepted B and closed — card moved to Closed.");
  });

  test("Accept sends the recommended option; Request changes sends none", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    await click(button("Accept Track"));
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ decision: "accept", option: "A" });
    trpcMock.reviewDecision.mutate.mockResolvedValue({ ok: true, decision: "changes", item: "shlo-k54.4.1.1", written: ["comment", "add-changes-label"], notified: { ok: true } });
    typeMessage("too risky");
    await click(button("Request changes"));
    const sent = trpcMock.reviewDecision.mutate.mock.calls[1]![0];
    expect(sent).toEqual({ project: "shlo", item: "shlo-k54.4.1.1", decision: "changes", message: "too risky" });
  });

  test("leaves out an option's absent what and risk from seen", async () => {
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [SHLO.options[0], { id: "B", label: "Bare" }] };
    await render(boardItem(raw));
    await click(button("BChoose"));
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0].seen).toEqual({ question: SHLO.question, label: "Bare" });
  });

  test("Ctrl/Cmd+Enter accepts the recommended option, and the hint names its id", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")), { acceptLabel: "Accept & next", changesLabel: "Request changes & next", optionSuffix: "& next", shortcuts: true });
    expect(container.textContent).toContain("accept A · add");
    expect(button("Accept Track").textContent).toContain("& next");
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ decision: "accept", option: "A", seen: { label: SHLO.options[0]!.label } });
  });

  test("shows the server's refusal in its own words", async () => {
    const refusal = Object.assign(new Error('Review "shlo-k54.4.1.1" changed since it was opened (option B or its question differs); reopen it. Nothing was written.'), { data: { httpStatus: 412 } });
    trpcMock.reviewDecision.mutate.mockRejectedValue(refusal);
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    await click(button("BChoose"));
    const alert = container.querySelector("[role=alert]")!;
    expect(alert.textContent).toBe(refusal.message);
  });

  test("folds more than two other options behind Choose another…, operable by keyboard", async () => {
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [...SHLO.options, { id: "D", label: "Defer a week" }] };
    await render(boardItem(raw));
    expect(buttons().some((b) => b.textContent?.startsWith("BChoose"))).toBe(false);
    const toggle = button("Choose another…");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls")!)}`)!;
    const items = [...list.querySelectorAll("button")];
    expect(items.map((b) => b.textContent)).toEqual(["BChoose Drop on 11-12 on current evidence (option B)", "CChoose Don't drop (option C)", "DChoose Defer a week (option D)"]);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(items[2]);
    await act(async () => {
      items[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    await click(toggle);
    await click(button("DChoose"));
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ option: "D", seen: { label: "Defer a week" } });
  });
});

describe("a card without options", () => {
  test("shows its pair side by side and its evidence open, and keeps plain Accept / Request changes", async () => {
    await render(boardItem(fixtureReview("before-after"), "The picker writes the same `default_view` edge."));
    expect(sectionTitles()).toEqual(["Question", "On accept · 1 step", "Before / after", "Diagrams · 1", "Evidence", "Thread · 0"]);
    const pair = [...container.querySelectorAll("figcaption")].slice(0, 2).map((f) => f.textContent);
    expect(pair).toEqual(["BeforePicker in the toolbar today", "AfterPicker in the node header"]);
    expect(container.querySelector("[data-stub=evidence]")).not.toBeNull();
    await click(button("Accept"));
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toEqual({ project: "shlo", item: "shlo-k54.4.1.1", decision: "accept", message: "" });
  });
});

describe("a legacy review", () => {
  test("shows its whole summary and screenshots, and is decided as before", async () => {
    const shot = `${ROOT}/shlo/shlo-k54.4.1.1/01-board.png`;
    await render(boardItem({ images: [shot], pane: null, summary: "Board header\nwith a second line" }, "Board header\nwith a second line"));
    expect(sectionTitles()).toEqual(["Summary", "Screenshots · 1", "Thread · 0"]);
    expect(container.textContent).toContain("Board header\nwith a second line");
    expect(container.querySelector("[data-stub=evidence]")).toBeNull();
    expect(container.querySelector("button[aria-label^='Enlarge screenshot 1: 01-board.png']")).not.toBeNull();
    expect(buttons().filter((b) => /^(Accept|Request)/.test(b.textContent ?? "")).map((b) => b.textContent)).toEqual(["Accept", "Request changes"]);
    await click(button("Accept"));
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toEqual({ project: "shlo", item: "shlo-k54.4.1.1", decision: "accept", message: "" });
    expect(container.textContent).toContain("Accepted and closed — card moved to Closed.");
  });

  test("a review the tracker holds malformed says it could not be read and keeps plain decisions", async () => {
    await render(boardItem({ images: [], pane: null, summary: "q", question: "q", options: [{ id: "A", label: "a" }, { id: "A", label: "b" }] }));
    expect(container.querySelector("[role=note]")?.textContent).toContain("malformed in the tracker");
    expect(buttons().filter((b) => /^(Accept|Request)/.test(b.textContent ?? "")).map((b) => b.textContent)).toEqual(["Accept", "Request changes"]);
  });
});
