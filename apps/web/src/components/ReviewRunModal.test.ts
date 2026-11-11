// @vitest-environment jsdom
//
// The review-all run announces a card's option (decision-card-reviews,
// follow-up S4): the status line says "Accepted A on “…”" or "Chose B (not
// the recommendation) on “…”", and the end summary names the option in the
// review's row. ReviewItemPanel is stubbed — its own tests cover what it
// sends and reports — with buttons that report a written decision to the
// run, as the panel does. jsdom has no modal dialogs or matchMedia, so
// showModal/close and matchMedia are stand-ins.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { PanelDecisions, WrittenReport } from "./ReviewItemPanel.js";

vi.mock("../trpc.js", () => ({ trpc: {}, HttpStatusError: class HttpStatusError extends Error {} }));
vi.mock("./ReviewItemPanel.js", async () => {
  const { createElement: h } = await import("react");
  const report = (option: WrittenReport["option"]): WrittenReport => ({ notified: null, notifyFailed: false, option });
  return {
    ReviewItemPanel: ({ item, titleId, decisions }: { item: string; titleId: string; decisions: PanelDecisions }) =>
      h(
        "div",
        null,
        h("h2", { id: titleId }, item),
        h("button", { type: "button", onClick: () => decisions.onWritten?.("accept", report({ id: "A", recommended: true })) }, "stub accept A"),
        h("button", { type: "button", onClick: () => decisions.onWritten?.("accept", report({ id: "B", recommended: false })) }, "stub choose B"),
        h("button", { type: "button", onClick: () => decisions.onWritten?.("accept", report(null)) }, "stub accept plain"),
      ),
  };
});

const { ReviewRunModal } = await import("./ReviewRunModal.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const review = (n: number) => ({ id: `id-${n}`, project: "p", externalId: `p-${n}`, title: `Card ${n}`, summaryLine: null, imageCount: 0, requestedAt: "2026-11-05T09:00:00.000Z", parent: null });

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button ${text}`);
  await act(async () => {
    button.click();
  });
}

test("the status line and the summary name the option each card was decided with", async () => {
  const queue = { reviews: [review(1), review(2), review(3)], total: 3, truncated: false, version: 1, error: null, loaded: true };
  await act(async () => {
    root.render(createElement(ReviewRunModal, { queue, drafts: new Map(), onEnd: () => {} }));
  });
  const status = () => container.querySelector("header [role=status]")!.textContent;
  await click("stub accept A");
  expect(status()).toBe("Accepted A on “Card 1”. 2 of 3.");
  await click("stub choose B");
  expect(status()).toBe("Chose B (not the recommendation) on “Card 2”. 3 of 3.");
  await click("stub accept plain");
  expect(status()).toBe("Accepted “Card 3”. Run complete.");
  const rows = [...container.querySelectorAll("ol[aria-label=\"This run's reviews\"] li")].map((li) => li.lastElementChild!.textContent);
  expect(rows).toEqual(["Accepted A", "Chose B (not the recommendation)", "Accepted"]);
});
