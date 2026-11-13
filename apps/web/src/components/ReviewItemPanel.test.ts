// @vitest-environment jsdom
//
// ReviewItemPanel with a decision card (decision-card-reviews, tasks.md 6.1,
// 6.3, 6.5). The item is the real `boardItem` answer for the fixture cards —
// normalized by core and shaped by server/dto.ts, as the server serves it —
// and the tRPC client is mocked, so these tests check what the panel shows
// and what it sends: the card's sections in spec order, the option actions
// and the `seen` they send, the fold, the shortcuts (including from a
// focused option, from the fold, and from a dialog inside the panel),
// refusals, what the host hears, the stage layout, and a legacy review shown
// and decided as before. EvidenceView (tiptap) and MermaidBlock (mermaid)
// are stubbed; they have their own tests (EvidenceView.test.ts). The
// MermaidBlock stub draws an open <dialog> with a button, standing in for
// the enlarged diagram (a dialog the panel itself opened).
//
// Videos (video-review-attachments, tasks.md 3.4, 4.2): jsdom has no media
// playback and no modal dialogs, so `play`/`pause` and `showModal`/`close`
// are stubbed, and a player's time is set through `currentTime`, which jsdom
// stores without playing anything.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewMetadata, type BoardItem } from "@breakdown/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toBoardItemDto } from "../../server/dto.js";
import type { PanelDecisions, ReviewItemPanelProps } from "./ReviewItemPanel.js";

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
  return {
    MermaidBlock: ({ caption, fill }: { source: string; caption?: string; fill?: boolean }) =>
      h("figure", { "data-stub": "mermaid", "data-fill": fill ? "" : undefined }, caption ?? "Diagram", h("dialog", { open: true }, h("button", { type: "button", "data-stub": "in-dialog" }, "Close"))),
  };
});

const { ReviewItemPanel } = await import("./ReviewItemPanel.js");

const pauseSpy = vi.fn();
HTMLMediaElement.prototype.play = vi.fn(async () => {});
HTMLMediaElement.prototype.pause = pauseSpy;
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "review-cards");
const ROOT = "/home/me/.local/share/breakdown/reviews";

function fixtureReview(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8").replaceAll("/REVIEW_ROOT", ROOT));
}

function boardItem(rawReview: unknown, content = "", overrides: Partial<BoardItem> = {}): unknown {
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
    ...overrides,
  };
  return JSON.parse(JSON.stringify(toBoardItemDto(item, ROOT)));
}

const SHLO_DIFF_CAPTION = "Migrations on branch retire-omni-v5-v8 at 7aa2657 (not on main)";
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

async function render(item: unknown, decisions?: PanelDecisions, props: Partial<ReviewItemPanelProps> = {}) {
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
        ...props,
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
    expect(container.textContent).toContain("Chose B (not the recommendation) and closed — card moved to Closed.");
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
    expect(container.textContent).toContain("accept option A · add");
    expect(button("Accept Track").textContent).toContain("& next");
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ decision: "accept", option: "A", seen: { label: SHLO.options[0]!.label } });
  });

  test("a refusal because the card moved re-reads the card at once and says so, keeping the typed message", async () => {
    const refusal = Object.assign(new Error('Review "shlo-k54.4.1.1" changed since it was opened (option B or its question differs); reopen it. Nothing was written.'), { data: { httpStatus: 412 } });
    trpcMock.reviewDecision.mutate.mockRejectedValue(refusal);
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    typeMessage("go with B");
    const moved = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [SHLO.options[0], { ...SHLO.options[1], label: "Drop the table" }, SHLO.options[2]] };
    trpcMock.boardItem.query.mockResolvedValue({ item: boardItem(moved) });
    expect(trpcMock.boardItem.query).toHaveBeenCalledTimes(1);
    await click(button("BChoose"));
    const alert = container.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("This card changed while you were reading it. It now shows the current version — read it again before deciding. Nothing was written.");
    expect(alert.textContent).toContain(refusal.message);
    expect(trpcMock.boardItem.query).toHaveBeenCalledTimes(2);
    expect(button("BChoose").textContent).toContain("Drop the table");
    expect(container.querySelector("textarea")!.value).toBe("go with B");
  });

  test("any other 4xx refusal is shown in the server's words, without a re-read", async () => {
    const refusal = Object.assign(new Error('Review "shlo-k54.4.1.1" is already closed.'), { data: { httpStatus: 409 } });
    trpcMock.reviewDecision.mutate.mockRejectedValue(refusal);
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    await click(button("Accept Track"));
    expect(container.querySelector("[role=alert]")!.textContent).toBe(refusal.message);
    expect(trpcMock.boardItem.query).toHaveBeenCalledTimes(1);
  });

  test("tells the host which option was accepted and whether it was the recommendation", async () => {
    const onWritten = vi.fn();
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")), { acceptLabel: "Accept & next", changesLabel: "Request changes & next", onWritten });
    await click(button("Accept Track"));
    expect(onWritten.mock.calls[0]![1].option).toEqual({ id: "A", recommended: true });
    expect(container.textContent).toContain("Accepted A and closed");
  });

  test("Ctrl/Cmd+Enter on a focused Choose button takes that option, never the recommendation; on the fold's toggle it takes nothing", async () => {
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [...SHLO.options, { id: "D", label: "Defer a week" }] };
    await render(boardItem(raw), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true });
    const toggle = button("Choose another…");
    await act(async () => {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).not.toHaveBeenCalled();
    await click(toggle);
    await act(async () => {
      button("CChoose").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ option: "C", seen: { label: "Don't drop" } });
  });

  test("Ctrl/Cmd+Enter on an inline Choose button takes that option", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true });
    await act(async () => {
      button("BChoose").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ option: "B" });
  });

  test("a focused Choose button shows its option's clamped text in full and is described by it", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    const choose = button("CChoose");
    const desc = container.querySelector(`#${CSS.escape(choose.getAttribute("aria-describedby")!)}`)!;
    expect(desc.textContent).toContain(SHLO.options[2]!.risk);
    expect(desc.querySelector(".line-clamp-2")).not.toBeNull();
    await act(async () => {
      choose.focus();
    });
    expect(desc.querySelector(".line-clamp-2")).toBeNull();
    expect(desc.closest("li")!.hasAttribute("data-focused")).toBe(true);
    await act(async () => {
      choose.blur();
    });
    expect(desc.querySelector(".line-clamp-2")).not.toBeNull();
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

  test("Escape inside the fold or on its open toggle closes the list only, never the drawer", async () => {
    const onEscape = vi.fn();
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [...SHLO.options, { id: "D", label: "Defer a week" }] };
    await render(boardItem(raw), undefined, { onEscape });
    const toggle = button("Choose another…");
    await click(toggle);
    await act(async () => {
      button("BChoose").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await act(async () => {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(onEscape).not.toHaveBeenCalled();
    await act(async () => {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("disables the fold's toggle while a decision is being written", async () => {
    let resolve: (v: unknown) => void = () => {};
    trpcMock.reviewDecision.mutate.mockReturnValue(new Promise((r) => (resolve = r)));
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), options: [...SHLO.options, { id: "D", label: "Defer a week" }] };
    await render(boardItem(raw));
    await click(button("Accept Track"));
    expect(button("Choose another…").disabled).toBe(true);
    await act(async () => {
      resolve({ ok: true, decision: "accept", item: "x", written: ["comment"], notified: null });
    });
  });
});

describe("a card that recommends nothing", () => {
  test("shows three Choose buttons and no Accept; Ctrl/Cmd+Enter does nothing and the hint offers only request changes", async () => {
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), recommend: undefined };
    await render(boardItem(raw), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true });
    expect(buttons().filter((b) => /Choose|^Accept/.test(b.textContent ?? "")).map((b) => b.getAttribute("data-option-id"))).toEqual(["A", "B", "C"]);
    expect(buttons().some((b) => b.textContent?.startsWith("Accept"))).toBe(false);
    const hint = container.querySelector("[aria-hidden=true].lg\\:inline-flex")!;
    expect(hint.textContent).toBe("Ctrl/⌘ShiftEnter request changes");
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).not.toHaveBeenCalled();
  });

  test("folds four or more under Choose an option…", async () => {
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), recommend: undefined, options: [...SHLO.options, { id: "D", label: "Defer a week" }] };
    await render(boardItem(raw));
    expect(button("Choose an option…").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("keys from a dialog inside the panel", () => {
  test("Ctrl/Cmd+Enter and Escape inside it neither decide nor leave", async () => {
    const onEscape = vi.fn();
    await render(boardItem(fixtureReview("before-after")), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true }, { onEscape });
    const inDialog = container.querySelector<HTMLElement>("[data-stub=in-dialog]")!;
    await act(async () => {
      inDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
      inDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("the run's compact frame", () => {
  test("a compact header is one row whose title carries its full text in a tooltip", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")), undefined, { compactHeader: true });
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    expect(title.getAttribute("title")).toBe("Review: Retire omni_search v5–v8");
    expect(title.className).toContain("truncate");
    expect(title.parentElement!.textContent).toContain("shlo-k54.4.1.1");
    expect(title.parentElement!.textContent).toContain("review");
  });

  test("with a hint target the hint is drawn there and the recipient describes the message box instead of taking a line", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const raw = { ...(fixtureReview("shlo-k54.4.1.1") as object), pane: "w2:p1", socket: undefined };
    await render(boardItem(raw), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true, hintTarget: target });
    expect(target.textContent).toBe("Ctrl/⌘Enter accept option A · add Shift to request changes");
    const box = container.querySelector("textarea")!;
    const recipient = "Pane w2:p1 has no herdr session recorded — the comment is the record";
    expect(box.getAttribute("title")).toBe(recipient);
    const described = box.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual([recipient]);
    expect([...container.querySelectorAll("span[title]")].some((el) => el.textContent === recipient)).toBe(false);
    target.remove();
  });

  test("without one the drawer keeps its recipient line", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")));
    const box = container.querySelector("textarea")!;
    expect(box.hasAttribute("title")).toBe(false);
    expect(box.hasAttribute("aria-describedby")).toBe(false);
    expect([...container.querySelectorAll("span[title]")].some((el) => el.textContent?.startsWith("Will notify pane"))).toBe(true);
  });
});

describe("the run's stage", () => {
  test("a lone diff fills the stage beside the card", async () => {
    await render(boardItem(fixtureReview("shlo-k54.4.1.1")), undefined, { layout: "stage" });
    const diffs = container.querySelector("section[aria-label='Diffs · 1']")!;
    expect(diffs.className).toContain("flex-[2]");
    expect(diffs.querySelector("[role=region][tabindex='0']")?.getAttribute("aria-label")).toBe(SHLO_DIFF_CAPTION);
    expect(diffs.querySelector("figure")!.className).toContain("h-full");
    expect(sectionTitles()).toEqual(["Diffs · 1", "Question", "Options · 3", "On accept · 3 steps", "Thread · 0"]);
  });

  test("a before/after pair takes the larger share above a lone diagram, which fills its own", async () => {
    await render(boardItem(fixtureReview("before-after")), undefined, { layout: "stage" });
    const pair = container.querySelector("section[aria-label='Before / after']")!;
    const diagrams = container.querySelector("section[aria-label='Diagrams · 1']")!;
    expect(pair.className).toContain("flex-[3]");
    expect(diagrams.className).toContain("flex-[2]");
    expect(pair.compareDocumentPosition(diagrams) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(diagrams.querySelector("h3")).toBeNull();
    expect(diagrams.querySelector("[data-stub=mermaid]")!.hasAttribute("data-fill")).toBe(true);
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
    // The summary renders as markdown, through the same read-only renderer as a card's evidence; there is no separate evidence section.
    expect([...container.querySelectorAll("[data-stub=evidence]")].map((e) => e.textContent)).toEqual(["Board header\nwith a second line"]);
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

describe("an item that is not a review", () => {
  test("renders its description as markdown", async () => {
    const body = "## Why\n\n- first\n- second\n\n## Acceptance criteria\n\nDone when `pnpm check` passes";
    await render(boardItem(null, body, { title: "Ship it", labels: [], isReview: false, review: null }));
    expect(sectionTitles()).toContain("Description");
    expect([...container.querySelectorAll("[data-stub=evidence]")].map((e) => e.textContent)).toEqual([body]);
  });
});

describe("a card with video cuts", () => {
  const RAW = "/review-images/PROJECT/BEAD";
  const V = `?v=${encodeURIComponent("2026-11-05T12:00:00.000Z")}`;
  const cuts = () => [...container.querySelectorAll<HTMLLIElement>("section[aria-label='Cuts · 2'] li")];
  const videoIn = (el: Element) => el.querySelector("video")!;

  test("shows each option's cut side by side in card order under its id and label, then the plain video", async () => {
    await render(boardItem(fixtureReview("reel-cuts")));
    expect(sectionTitles()).toEqual(["Question", "Options · 2", "On accept · 1 step", "Cuts · 2", "Videos · 1", "Thread · 0"]);
    const [a, b] = cuts();
    expect(cuts().map((li) => li.getAttribute("data-option-id"))).toEqual(["A", "B"]);
    expect(a!.textContent).toContain("Option A: Cut 1: open on the stalls");
    expect(a!.textContent).toContain("Recommended");
    expect(b!.textContent).toContain("Option B: Cut 2: open on the baker");
    expect(b!.textContent).not.toContain("Recommended");
    expect(videoIn(a!).getAttribute("src")).toBe(`${RAW}/01-reel-a.mp4${V}`);
    expect(videoIn(a!).getAttribute("poster")).toBe(`${RAW}/02-reel-a-poster.jpg${V}`);
    expect(videoIn(b!).getAttribute("src")).toBe(`${RAW}/03-reel-b.mp4${V}`);
    expect(videoIn(b!).hasAttribute("poster")).toBe(false);
    const plain = container.querySelector("section[aria-label='Videos · 1']")!;
    expect(plain.querySelectorAll("video")).toHaveLength(1);
    expect(videoIn(plain).getAttribute("src")).toBe(`${RAW}/04-reel-raw.mp4${V}`);
    expect(plain.textContent).toContain("The raw footage both cuts come from");
  });

  test("plays muted, with controls, on a click, loading metadata only, and loops until Loop is turned off", async () => {
    await render(boardItem(fixtureReview("reel-cuts")));
    for (const video of container.querySelectorAll("video")) {
      expect(video.muted).toBe(true);
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.hasAttribute("playsinline")).toBe(true);
      expect(video.getAttribute("preload")).toBe("metadata");
      expect(video.loop).toBe(true);
    }
    const loop = container.querySelector<HTMLButtonElement>("button[aria-label='Loop option A: Cut 1']")!;
    expect(loop.getAttribute("aria-pressed")).toBe("true");
    await click(loop);
    expect(loop.getAttribute("aria-pressed")).toBe("false");
    expect(videoIn(cuts()[0]!).loop).toBe(false);
    expect(videoIn(cuts()[1]!).loop).toBe(true);
  });

  test("shows a video it cannot serve as unavailable, with its path", async () => {
    const raw = fixtureReview("reel-cuts") as { attachments: Array<Record<string, unknown>> };
    raw.attachments[2] = { kind: "video", path: "/elsewhere/raw.mp4" };
    await render(boardItem(raw));
    const plain = container.querySelector("section[aria-label='Videos · 1']")!;
    expect(plain.querySelector("video")).toBeNull();
    expect(plain.textContent).toContain("Can't show: /elsewhere/raw.mp4");
  });

  test("Enlarge opens the video in a dialog at the inline time, closing brings the time back, and the panel holds its shortcuts meanwhile", async () => {
    await render(boardItem(fixtureReview("reel-cuts")), { acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true });
    const inline = videoIn(cuts()[0]!);
    inline.currentTime = 5;
    pauseSpy.mockClear();
    const enlarge = container.querySelector<HTMLButtonElement>("button[aria-label='Enlarge video: option A: Cut 1']")!;
    await click(enlarge);
    expect(pauseSpy).toHaveBeenCalled();
    const dialog = container.querySelector("dialog[open]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Video 1 of 1: 01-reel-a.mp4");
    const big = dialog.querySelector("video")!;
    expect(big.autoplay).toBe(true);
    expect(big.muted).toBe(true);
    expect(big.getAttribute("poster")).toBe(`${RAW}/02-reel-a-poster.jpg${V}`);
    await act(async () => {
      big.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(big.currentTime).toBe(5);

    // The overlay is reported: Cmd+Enter outside the dialog decides nothing while it is open.
    const title = container.querySelector<HTMLElement>("[data-panel-title]")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate).not.toHaveBeenCalled();

    big.currentTime = 9;
    await click(dialog.querySelector<HTMLButtonElement>("button[aria-label=Close]")!);
    expect(container.querySelector("dialog video")).toBeNull();
    expect(inline.currentTime).toBe(9);
    expect(document.activeElement).toBe(enlarge);
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(trpcMock.reviewDecision.mutate.mock.calls[0]![0]).toMatchObject({ decision: "accept", option: "A" });
  });

  test("arrow keys on the enlarged video are the video's, not the lightbox's", async () => {
    await render(boardItem(fixtureReview("reel-cuts")));
    await click(container.querySelector<HTMLButtonElement>("button[aria-label='Enlarge video: option B: Cut 2']")!);
    const big = container.querySelector("dialog video")!;
    const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    await act(async () => {
      big.dispatchEvent(key);
    });
    expect(key.defaultPrevented).toBe(false);
    expect(container.querySelector("dialog video")).toBe(big);
  });
});
