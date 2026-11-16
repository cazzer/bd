// @vitest-environment jsdom
//
// The review control (shared-nav-header tasks.md 2.3-2.4; app-navigation
// spec "The review control reaches the queue and the inbox"): it names its
// review and inbox counts to assistive technology; it still shows and runs
// the queue when the inbox read fails; its popover's "Go to inbox" opens
// Needs me with the reader's project and closes the popover; the popover
// anchors to, and returns focus to, the pill that opened it; and a review
// decided through the queue leaves the inbox's Needs me without a reload,
// because both read the shell's one queue state. The tRPC client and
// `navigate` are mocked; the drawer, the run-through, and InboxView's heavy
// children are stubbed (they have their own tests).

import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReviewQueueState } from "../lib/reviewQueueReader.js";
import type { InboxRoute, Route } from "../lib/route.js";

const trpcMock = vi.hoisted(() => ({
  inbox: { query: vi.fn() },
  inboxDecision: { mutate: vi.fn() },
  relayActionsFor: { query: vi.fn() },
  reviewDecision: { mutate: vi.fn() },
}));
vi.mock("../trpc.js", () => ({ trpc: trpcMock, HttpStatusError: class HttpStatusError extends Error {} }));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/navigate.js", async (importOriginal) => ({ ...(await importOriginal<object>()), navigate: navigateMock }));
vi.mock("../lib/useRelayStatus.js", () => ({ useRelayStatus: () => null }));
vi.mock("./ReviewDrawer.js", async () => {
  const { createElement: h } = await import("react");
  return {
    useWideDrawer: () => true,
    // The drawer decides through `reviewDecision` and tells the shell, as the real one does.
    ReviewDrawer: ({ project, item, onDecided, onClose }: { project: string; item: string; onDecided: () => void; onClose: () => void }) =>
      h("div", { role: "dialog", "data-stub": "drawer", "data-item": `${project}/${item}` }, [
        h(
          "button",
          {
            key: "accept",
            type: "button",
            onClick: async () => {
              await trpcMock.reviewDecision.mutate({ project, item, decision: "accept" });
              onDecided();
            },
          },
          "Accept review",
        ),
        h("button", { key: "close", type: "button", onClick: onClose }, "Close drawer"),
      ]),
  };
});
vi.mock("./ReviewRunModal.js", () => ({ ReviewRunModal: () => null }));
vi.mock("./HeaderSearch.js", () => ({ HeaderSearch: () => null }));
vi.mock("./ReviewItemPanel.js", () => ({ ReviewItemPanel: () => null }));
vi.mock("./EvidenceView.js", () => ({ EvidenceView: () => null }));

const { ReviewQueuePill, ReviewQueueProvider } = await import("./ReviewQueue.js");
const { InboxView } = await import("./InboxView.js");
const { useInboxCount } = await import("../lib/useInboxCount.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function review(n: number) {
  return {
    id: `00000000-0000-4000-8000-00000000010${n}`,
    project: "tides",
    externalId: `tides-${n}`,
    title: `Review: Ship part ${n}`,
    summaryLine: `Is part ${n} right?`,
    imageCount: 0,
    requestedAt: `2026-11-1${n}T09:00:00.000Z`,
    parent: null,
  };
}

function queueOf(reviews: ReturnType<typeof review>[], version = 1): ReviewQueueState {
  return { reviews, total: reviews.length, truncated: false, version, error: null, loaded: true } as unknown as ReviewQueueState;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const m of [trpcMock.inbox.query, trpcMock.inboxDecision.mutate, trpcMock.relayActionsFor.query, trpcMock.reviewDecision.mutate, navigateMock]) m.mockReset();
  trpcMock.inbox.query.mockResolvedValue({ items: [], total: 0, truncated: false });
  trpcMock.reviewDecision.mutate.mockResolvedValue({ ok: true });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
  history.replaceState(null, "", "/graph");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const GRAPH: Route = { view: "graph", q: null, types: [], node: null, projects: [] };

function shell(queue: ReviewQueueState, route: Route, children: ReactNode) {
  act(() => root.render(createElement(ReviewQueueProvider, { queue, live: "live", route, children })));
}

/** The text a screen reader names a control by: everything not under `aria-hidden`. */
function spokenText(el: Element): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
    else if (node instanceof Element && node.getAttribute("aria-hidden") !== "true") out += spokenText(node);
  }
  return out;
}

function pills(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[data-review-control]")];
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby]');
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

function linkIn(scope: Element, label: string): HTMLAnchorElement {
  const found = [...scope.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === label);
  if (found === undefined) throw new Error(`no ${label} link`);
  return found;
}

function buttonIn(scope: Element | Document, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

describe("the review control's counts", () => {
  test("names the reviews and the inbox items, each in its own sr-only text, and hides the bare numbers", () => {
    shell(queueOf([review(1), review(2)]), GRAPH, createElement(ReviewQueuePill, { compact: true, inboxCount: 3 }));
    const [pill] = pills();
    expect(spokenText(pill!)).toBe("Live, 2 reviews pending, 3 inbox items need you");
    expect(pill!.querySelector('[data-count="reviews"]')?.className).toBe("sr-only");
    expect(pill!.querySelector('[data-count="inbox"]')?.textContent).toBe(", 3 inbox items need you");
    expect(pill!.getAttribute("title")).toBe("Live, 2 reviews pending, 3 inbox items need you");
    const shownNumbers = [...pill!.children].filter((el) => el.getAttribute("aria-hidden") === "true").map((el) => el.textContent);
    expect(shownNumbers).toEqual(["2", "3"]);
  });

  test("shows no inbox count at zero or when it is unknown", () => {
    shell(queueOf([review(1)]), GRAPH, createElement(ReviewQueuePill, { inboxCount: 0 }));
    expect(spokenText(pills()[0]!)).toBe("Live, 1 review pending");
    shell(queueOf([review(1)]), GRAPH, createElement(ReviewQueuePill, { inboxCount: null }));
    expect(pills()[0]!.querySelector('[data-count="inbox"]')).toBeNull();
  });
});

/** The header's wiring: the shell's own inbox poll feeding the pill. */
function HeaderControl() {
  return createElement(ReviewQueuePill, { compact: true, inboxCount: useInboxCount() });
}

describe("the review control with the inbox read failing", () => {
  test("still shows the review count and runs the queue", async () => {
    trpcMock.inbox.query.mockRejectedValue(new Error("connection refused"));
    shell(queueOf([review(1)]), GRAPH, createElement(HeaderControl));
    await flush();
    expect(trpcMock.inbox.query).toHaveBeenCalled();
    const [pill] = pills();
    expect(spokenText(pill!)).toBe("Live, 1 review pending");
    click(pill!);
    const dialog = popover()!;
    expect(dialog).not.toBeNull();
    click(dialog.querySelector('[data-review-id]')!);
    expect(document.querySelector('[data-stub="drawer"]')?.getAttribute("data-item")).toBe("tides/tides-1");
  });
});

describe("Go to inbox", () => {
  const TIDES_INBOX: InboxRoute = { view: "inbox", item: null, projects: ["tides"] };

  test("opens Needs me carrying the pill's projects, and closes the popover", () => {
    shell(queueOf([review(1)]), { ...GRAPH, projects: ["tides"] }, createElement(ReviewQueuePill, { inboxRoute: TIDES_INBOX }));
    click(pills()[0]!);
    const go = linkIn(popover()!, "Go to inbox");
    expect(go.getAttribute("href")).toBe("/inbox?project=tides");
    click(go);
    expect(navigateMock).toHaveBeenCalledWith(TIDES_INBOX, "push");
    expect(popover()).toBeNull();
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("false");
  });

  test("from a pill with no route of its own, carries the address's projects", () => {
    history.replaceState(null, "", "/feed?view=v1&project=skyos");
    shell(queueOf([]), { view: "feed", viewId: "v1", projects: ["skyos"] }, createElement(ReviewQueuePill));
    click(pills()[0]!);
    expect(linkIn(popover()!, "Go to inbox").getAttribute("href")).toBe("/inbox?project=skyos");
  });

  test("is not offered on the inbox itself", () => {
    shell(queueOf([]), { view: "inbox", item: null, projects: [] }, createElement(ReviewQueuePill));
    click(pills()[0]!);
    expect([...popover()!.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Open the board"]);
  });
});

describe("the popover's anchor", () => {
  test("is the pill that was activated, which alone is expanded and gets focus back", () => {
    // The header's pill first, then a view's own (as until group 3 removes view pills).
    shell(queueOf([review(1)]), GRAPH, createElement(Fragment, null, createElement(ReviewQueuePill, { key: "header", compact: true }), createElement(ReviewQueuePill, { key: "view" })));
    const [header, viewPill] = pills();
    click(header!);
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(viewPill!.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      popover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(header);

    click(viewPill!);
    expect(viewPill!.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      popover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).toBe(viewPill);
  });

  test("closing the drawer a pick opened returns focus to that pill once the review is decided", async () => {
    shell(queueOf([review(1)]), GRAPH, createElement(Fragment, null, createElement(ReviewQueuePill, { key: "header" }), createElement(ReviewQueuePill, { key: "view" })));
    const [header] = pills();
    click(header!);
    click(popover()!.querySelector("[data-review-id]")!);
    await act(async () => {
      buttonIn(document, "Accept review").click();
      await Promise.resolve();
    });
    click(buttonIn(document, "Close drawer"));
    await flush();
    expect(document.activeElement).toBe(header);
  });
});

describe("deciding through the queue", () => {
  test("leaves the inbox's Needs me without a reload", async () => {
    const inboxRoute: Route = { view: "inbox", item: null, projects: [] };
    history.replaceState(null, "", "/inbox");
    const both = (queue: ReviewQueueState) =>
      shell(queue, inboxRoute, createElement(Fragment, null, createElement(ReviewQueuePill, { key: "header", compact: true }), createElement(InboxView, { key: "inbox", item: null, source: null })));
    both(queueOf([review(1), review(2)]));
    await flush();
    const list = () => [...document.querySelectorAll('ul[aria-label="Inbox items"] li')].map((li) => li.textContent ?? "");
    expect(list().some((t) => t.includes("Ship part 1"))).toBe(true);
    expect(buttonIn(document, "Needs me 2")).toBeDefined();
    const reads = trpcMock.inbox.query.mock.calls.length;

    click(pills()[0]!);
    click(popover()!.querySelector('[data-review-id="00000000-0000-4000-8000-000000000101"]')!);
    await act(async () => {
      buttonIn(document, "Accept review").click();
      await Promise.resolve();
    });
    expect(trpcMock.reviewDecision.mutate).toHaveBeenCalledWith({ project: "tides", item: "tides-1", decision: "accept" });

    // The queue's next live read, which the shell hands every reader of the queue.
    both(queueOf([review(2)], 2));
    await flush();
    expect(list().some((t) => t.includes("Ship part 1"))).toBe(false);
    expect(list().some((t) => t.includes("Ship part 2"))).toBe(true);
    expect(buttonIn(document, "Needs me 1")).toBeDefined();
    expect(trpcMock.inbox.query.mock.calls.length).toBe(reads);
  });
});
