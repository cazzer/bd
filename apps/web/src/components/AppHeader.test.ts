// @vitest-environment jsdom
//
// The shell header (shared-nav-header tasks.md 1.3-1.5; app-navigation spec
// "Every view shares one header", "The Views menu lists saved views", "The
// chosen project follows the reader", "The header fits a phone"): the nav
// links carry the project and mark the current view, the switcher says when
// a view is not filtered, the Views menu reads once and fails in one line,
// and below the mid tier the nav collapses into a Menu disclosure named for
// the current place; the width tiers decide where search and the status
// chips go. The tRPC client, the queue's pill, the status polls, and the
// project registry are stubbed (they have their own tests). `matchMedia`
// answers `(min-width: Nrem)` against `env.width`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatRoute, parseRoute, type Route } from "../lib/route.js";
import type { HangarStatusView } from "../lib/hangarStatus.js";
import type { RelayStatusView } from "../lib/relayStatus.js";
import type { ShellProjects } from "../lib/shellNav.js";

const trpcMock = vi.hoisted(() => ({ list: { query: vi.fn() } }));
const navigateMock = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  width: 1440,
  wideDrawer: true,
  shellDrawerOpen: false,
  shell: { registry: ["skyos", "tides"], registryFailed: false, view: null } as ShellProjects,
  retries: 0,
  hangar: null as { status: HangarStatusView; at: Date } | null,
  relay: null as { status: RelayStatusView; at: Date } | null,
  inboxCount: null as number | null,
}));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));
vi.mock("../lib/navigate.js", () => ({ navigate: navigateMock }));
vi.mock("./ShellProjects.js", () => ({ useShellProjects: () => ({ ...env.shell, retryRegistry: () => (env.retries += 1) }) }));
vi.mock("./ReviewDrawer.js", () => ({ useWideDrawer: () => env.wideDrawer }));
vi.mock("./ReviewQueue.js", async () => {
  const { createElement: h } = await import("react");
  return {
    ReviewQueuePill: ({ compact, bare, inboxCount, inboxRoute, boardRoute }: { compact?: boolean; bare?: boolean; inboxCount?: number | null; inboxRoute?: Route; boardRoute?: Route }) =>
      h(
        "button",
        {
          type: "button",
          "data-stub": "review-pill",
          "data-compact": String(compact ?? false),
          "data-bare": String(bare ?? false),
          "data-inbox-count": String(inboxCount ?? null),
          "data-inbox-href": inboxRoute === undefined ? "" : formatRoute(inboxRoute),
          "data-board-href": boardRoute === undefined ? "" : formatRoute(boardRoute),
        },
        "reviews",
      ),
    useShellDrawer: () => ({ open: env.shellDrawerOpen, drafts: new Map() }),
  };
});
vi.mock("./HangarStatusPill.js", async (importOriginal) => ({ ...(await importOriginal<object>()), useHangarStatus: () => env.hangar }));
vi.mock("../lib/useRelayStatus.js", () => ({ useRelayStatus: () => env.relay }));
vi.mock("../lib/useInboxCount.js", () => ({ useInboxCount: () => env.inboxCount }));

const { AppHeader } = await import("./AppHeader.js");
const { forgetSavedViews } = await import("./ViewsMenu.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const HANGAR_ONLINE: HangarStatusView = { status: "online", hangar: "hangar-desktop", version: "0.4.1", lastSeenAt: new Date().toISOString(), intervalS: 30, now: new Date().toISOString(), queued: 2, claimed: 0, running: 1, capacity: null, capacityAt: null };
const RELAY: RelayStatusView = { status: "online", relay: "relay-laptop", version: "1.0.0", lastSeenAt: new Date().toISOString(), queued: 1, claimed: 0, missingBinaries: ["herdr"] };

beforeEach(() => {
  env.width = 1440;
  env.wideDrawer = true;
  env.shellDrawerOpen = false;
  env.shell = { registry: ["skyos", "tides"], registryFailed: false, view: null };
  env.retries = 0;
  env.hangar = { status: HANGAR_ONLINE, at: new Date() };
  env.relay = { status: RELAY, at: new Date() };
  env.inboxCount = null;
  navigateMock.mockReset();
  trpcMock.list.query.mockReset();
  forgetSavedViews();
  vi.stubGlobal("matchMedia", (query: string) => {
    const rem = /min-width:\s*([\d.]+)rem/.exec(query);
    return { matches: rem === null ? true : env.width >= Number(rem[1]) * 16, media: query, addEventListener() {}, removeEventListener() {} };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function at(url: string): Route {
  const i = url.indexOf("?");
  const route = i === -1 ? parseRoute(url, "") : parseRoute(url.slice(0, i), url.slice(i));
  if (route === null) throw new Error(`not a route: ${url}`);
  return route;
}

function render(url: string): HTMLElement {
  act(() => root.render(createElement(AppHeader, { route: at(url) })));
  return container.querySelector("header")!;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function link(label: string): HTMLAnchorElement {
  const found = [...container.querySelectorAll<HTMLAnchorElement>("nav a")].find((a) => a.textContent === label);
  if (found === undefined) throw new Error(`no ${label} link`);
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

function menuButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label^="Views and navigation"]');
  if (found === null) throw new Error("no Menu button");
  return found;
}

function click(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function key(name: string): void {
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

function panelOf(trigger: HTMLButtonElement): HTMLElement {
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
}

const VIEWS = [
  { id: "t1", title: "Shipping log", metadata: { renderer: "timeline" } },
  { id: "b1", title: "Tides board", metadata: { renderer: "board" } },
];

describe("AppHeader nav", () => {
  test("links every view carrying the project, marking the current one (Project survives a detour)", () => {
    render("/board?project=tides");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Main");
    expect(link("Board").getAttribute("aria-current")).toBe("page");
    expect(link("Graph").hasAttribute("aria-current")).toBe(false);
    expect(link("Graph").getAttribute("href")).toBe("/graph?project=tides");
    expect(link("Roadmap").getAttribute("href")).toBe("/roadmap?project=tides");
    expect(link("Inbox").getAttribute("href")).toBe("/inbox?project=tides");
    expect(link("Search").getAttribute("href")).toBe("/search?project=tides");
  });

  test("a plain click pushes the route; a modified click is the browser's (Reaching the inbox from the graph)", () => {
    render("/graph?project=tides");
    expect(link("Graph").getAttribute("aria-current")).toBe("page");
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      expect(click(link("Inbox"), init).defaultPrevented).toBe(false);
    }
    expect(navigateMock).not.toHaveBeenCalled();
    expect(click(link("Inbox")).defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith({ view: "inbox", item: null, projects: ["tides"] }, "push");
  });

  test("on a shared timeline link the switcher reads the project and Board opens on it (Shared link)", () => {
    render("/timeline?view=v1&project=tides");
    const select = container.querySelector("select")!;
    expect(select.value).toBe("tides");
    expect(link("Board").getAttribute("href")).toBe("/board?project=tides");
  });
});

describe("AppHeader project switcher", () => {
  test("on the inbox it says it does not filter, and a choice changes only the address (Unscoped view says so)", () => {
    render("/inbox?item=i1");
    const select = container.querySelector("select")!;
    expect(select.getAttribute("aria-description")).toBe("The inbox isn't filtered by project.");
    expect(select.getAttribute("title")).toBe("The inbox isn't filtered by project.");
    act(() => {
      select.value = "skyos";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith({ view: "inbox", item: "i1", projects: ["skyos"] }, "push");
  });

  test("on the board it carries no hint, and a choice drops the open item", () => {
    render("/board?project=tides&item=tides-r1");
    const select = container.querySelector("select")!;
    expect(select.hasAttribute("aria-description")).toBe(false);
    act(() => {
      select.value = "skyos";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith({ view: "board", viewId: null, projects: ["skyos"], item: null }, "push");
  });
});

describe("AppHeader inert", () => {
  test("is inert while a drawer is a modal sheet, and only then", () => {
    env.wideDrawer = false;
    expect(render("/board?item=tides-r1").hasAttribute("inert")).toBe(true);
    expect(render("/board").hasAttribute("inert")).toBe(false);
    env.shellDrawerOpen = true;
    expect(render("/inbox").hasAttribute("inert")).toBe(true);
    env.wideDrawer = true;
    expect(render("/board?item=tides-r1").hasAttribute("inert")).toBe(false);
  });
});

describe("Views menu", () => {
  test("reads the saved views once, on first open, and opens one with the project (Opening a saved timeline)", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/graph?project=tides");
    const views = button("Views");
    expect(views.getAttribute("aria-expanded")).toBe("false");
    expect(panelOf(views).hidden).toBe(true);
    expect(trpcMock.list.query).not.toHaveBeenCalled();

    click(views);
    await settle();
    expect(views.getAttribute("aria-expanded")).toBe("true");
    expect(trpcMock.list.query).toHaveBeenCalledWith({ nodeTypes: ["view"], limit: 200 });
    const panel = panelOf(views);
    expect([...panel.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Timelines", "Boards"]);
    const shipping = [...panel.querySelectorAll("a")].find((a) => a.textContent === "Shipping log")!;
    expect(shipping.getAttribute("href")).toBe("/timeline?view=t1&project=tides");

    click(shipping);
    expect(navigateMock).toHaveBeenCalledWith({ view: "timeline", viewId: "t1", node: null, types: [], projects: ["tides"] }, "push");
    expect(views.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(views);

    click(views);
    await settle();
    expect(trpcMock.list.query).toHaveBeenCalledTimes(1);
  });

  test("Escape closes it and returns focus to its button; a press outside closes it", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/graph");
    const views = button("Views");
    click(views);
    await settle();
    panelOf(views).querySelector("a")!.focus();
    key("Escape");
    expect(views.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(views);

    click(views);
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(views.getAttribute("aria-expanded")).toBe("false");
  });

  test("a failed read is one line inside the menu, and the rest of the header still works", async () => {
    trpcMock.list.query.mockRejectedValue(new Error("server down"));
    render("/graph");
    const views = button("Views");
    click(views);
    await settle();
    const alert = panelOf(views).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("server down");
    expect(click(link("Board")).defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalled();
  });
});

describe("AppHeader on a phone", () => {
  test("collapses the nav and Views into one Menu disclosure; a choice navigates with the project and closes it (Phone navigation)", async () => {
    env.width = 390;
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/inbox?project=tides");
    expect(() => button("Views")).toThrow();
    expect(container.querySelector("select")).not.toBeNull();
    expect(container.querySelector('[data-stub="review-pill"]')).not.toBeNull();

    const menu = menuButton();
    expect(menu.getAttribute("aria-label")).toBe("Views and navigation, current: Inbox");
    expect(menu.textContent).toBe("Inbox");
    const panel = panelOf(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);

    click(menu);
    await settle();
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(link("Inbox").getAttribute("aria-current")).toBe("page");
    expect([...panel.querySelectorAll("a")].some((a) => a.textContent === "Shipping log")).toBe(true);

    click(link("Roadmap"));
    expect(navigateMock).toHaveBeenCalledWith({ view: "roadmap", projects: ["tides"], item: null }, "push");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(menu);
  });

  test("Escape closes the Menu and returns focus to it", () => {
    env.width = 390;
    trpcMock.list.query.mockResolvedValue({ nodes: [], hasMore: false, nextCursor: null });
    render("/graph");
    const menu = menuButton();
    click(menu);
    link("Board").focus();
    key("Escape");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu);
  });
});

describe("AppHeader width tiers", () => {
  const searchBox = () => container.querySelector<HTMLInputElement>('header input[type="search"]');
  const hangarWords = () => container.querySelector("[data-hangar-pill] > span:not([aria-hidden])");
  const reviewPill = () => {
    const pill = container.querySelector('[data-stub="review-pill"]')!;
    return { compact: pill.getAttribute("data-compact"), bare: pill.getAttribute("data-bare") };
  };
  /** The status pills' box reports clipped content whenever `clipped` says so (jsdom lays nothing out). */
  const clipChips = (clipped: (chips: Element) => boolean) => {
    const isChips = (el: Element) => el.classList.contains("overflow-hidden") && el.querySelector("[data-hangar-pill]") !== null;
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      return isChips(this) && clipped(this) ? 200 : 0;
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return isChips(this) ? 100 : 1300;
    });
  };
  const inPanel = (el: Element | null) => el !== null && el.closest("[hidden], [id]") !== null && el.closest("[hidden]") !== null;

  test("wide: nav inline, a search box, worded status pills, the full review pill", () => {
    env.width = 1300;
    render("/board");
    expect(container.querySelector('nav[aria-label="Main"]')?.closest("[hidden]")).toBeNull();
    expect(searchBox()).not.toBeNull();
    expect(container.querySelector('button[aria-label="Search everything"]')).toBeNull();
    expect(hangarWords()?.className).toBe("sr-only sm:not-sr-only");
    expect(reviewPill()).toEqual({ compact: "false", bare: "false" });
  });

  test("wide on the graph: search is the magnifier, so the graph's own bar is the only box", () => {
    env.width = 1300;
    render("/graph");
    expect(searchBox()).toBeNull();
    expect(container.querySelector('button[aria-label="Search everything"]')).not.toBeNull();
  });

  test("wide: clipped status words go compact first, and the review pill keeps its count words", () => {
    env.width = 1300;
    // Clipped only while a status pill shows its words.
    clipChips((chips) => chips.querySelector(".sm\\:not-sr-only") !== null);
    render("/graph");
    expect(hangarWords()?.className).toBe("sr-only");
    expect(reviewPill()).toEqual({ compact: "true", bare: "false" });
  });

  test("wide or mid: when even the compact status pills are clipped, the review pill goes to bare numbers", () => {
    clipChips(() => true);
    env.width = 1300;
    render("/graph");
    expect(reviewPill()).toEqual({ compact: "true", bare: "true" });
  });

  test("mid: nav inline, search behind a magnifier, compact pills", () => {
    env.width = 1000;
    render("/graph");
    expect(button("Views")).toBeDefined();
    expect(searchBox()).toBeNull();
    const magnifier = container.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!;
    expect(magnifier.getAttribute("aria-expanded")).toBe("false");
    click(magnifier);
    expect(document.activeElement).toBe(searchBox());
    expect(hangarWords()?.className).toBe("sr-only");
    expect(container.querySelector("[data-relay-pill]")).not.toBeNull();
    expect(reviewPill()).toEqual({ compact: "true", bare: "false" });
  });

  test("narrow: a Menu, with compact status pills still inline", () => {
    env.width = 700;
    render("/graph");
    expect(() => button("Views")).toThrow();
    expect(menuButton()).toBeDefined();
    const hangar = container.querySelector("[data-hangar-pill]");
    expect(hangar).not.toBeNull();
    expect(hangar!.closest("[hidden]")).toBeNull();
    expect(reviewPill()).toEqual({ compact: "true", bare: "true" });
  });

  test("phone: the status pills move into the Menu, which flags an offline status", () => {
    env.width = 390;
    render("/graph");
    expect(reviewPill()).toEqual({ compact: "true", bare: "true" });
    expect(inPanel(container.querySelector("[data-hangar-pill]"))).toBe(true);
    expect(container.querySelector("[data-menu-warning]")).toBeNull();
    env.hangar = { status: { ...HANGAR_ONLINE, status: "offline" }, at: new Date() };
    render("/graph");
    expect(container.querySelector("[data-menu-warning]")).not.toBeNull();
    expect(menuButton().getAttribute("aria-label")).toBe("Views and navigation, current: Graph (a status is offline)");
  });
});

describe("AppHeader review control", () => {
  test("gets the header's inbox count and a Go to inbox route on Needs me carrying the project", () => {
    env.inboxCount = 3;
    render("/roadmap?project=tides&item=tides-1");
    const pill = container.querySelector('[data-stub="review-pill"]')!;
    expect(pill.getAttribute("data-inbox-count")).toBe("3");
    expect(pill.getAttribute("data-inbox-href")).toBe("/inbox?project=tides");
    expect(pill.getAttribute("data-board-href")).toBe("/board?project=tides");
  });
});

describe("AppHeader current saved view", () => {
  test("marks the Views trigger and the open view's row; Board opens the plain board", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/board?view=b1&project=tides");
    expect(link("Board").hasAttribute("aria-current")).toBe(false);
    expect(link("Board").getAttribute("href")).toBe("/board?project=tides");
    const views = button("Views");
    expect(views.getAttribute("aria-description")).toBe("A saved view is open");
    click(views);
    await settle();
    const rows = [...panelOf(views).querySelectorAll("a")];
    expect(rows.find((a) => a.textContent === "Tides board")?.getAttribute("aria-current")).toBe("page");
    expect(rows.find((a) => a.textContent === "Shipping log")?.hasAttribute("aria-current")).toBe(false);
  });

  test("the collapsed Menu is named for the saved view once read, else its renderer", () => {
    env.width = 700;
    render("/timeline?view=t1");
    expect(menuButton().getAttribute("aria-label")).toBe("Views and navigation, current: Timeline");
    env.shell = { ...env.shell, view: { viewId: "t1", title: "Shipping log", renderer: "timeline", projects: null } };
    render("/timeline?view=t1");
    expect(menuButton().getAttribute("aria-label")).toBe("Views and navigation, current: Shipping log");
  });

  test("says when more views exist than one read lists", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: true, nextCursor: { updatedAt: "x", id: "y" } });
    render("/graph");
    click(button("Views"));
    await settle();
    expect(panelOf(button("Views")).textContent).toContain("More views not listed.");
  });
});

describe("AppHeader not-filtered state", () => {
  test("a visible tag in the switcher's box, and on a phone the Menu's first line", () => {
    render("/inbox");
    expect(container.querySelector("[data-unfiltered-marker]")?.textContent).toBe("unfiltered");
    // The phone's mark (shown below `sm` only) is a dot; the project's text stays full colour there.
    expect(container.querySelector("[data-unfiltered-dot]")).not.toBeNull();
    expect(container.querySelector("header select")?.className).toMatch(/(^| )text-fg( |$)/);
    render("/board");
    expect(container.querySelector("[data-unfiltered-marker]")).toBeNull();
    expect(container.querySelector("[data-unfiltered-dot]")).toBeNull();
    env.width = 390;
    act(() => root.unmount());
    root = createRoot(container);
    render("/inbox");
    expect(panelOf(menuButton()).firstElementChild?.textContent).toBe("The inbox isn't filtered by project.");
  });

  test("a lone project is focusable text carrying the hint", () => {
    env.shell = { ...env.shell, registry: ["tides"] };
    render("/inbox");
    const lone = [...container.querySelectorAll<HTMLElement>("header span[aria-description]")][0]!;
    expect(lone.tabIndex).toBe(0);
    expect(lone.getAttribute("aria-description")).toBe("The inbox isn't filtered by project.");
  });

  test("an empty registry keeps the switcher's width, and a failed one is retried on focus", () => {
    env.shell = { ...env.shell, registry: [] };
    render("/graph");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("header span.w-36[aria-hidden]")).not.toBeNull();
    env.shell = { registry: null, registryFailed: true, view: null };
    render("/graph?project=tides");
    act(() => container.querySelector("select")!.focus());
    expect(env.retries).toBe(1);
  });
});

describe("AppHeader disclosures", () => {
  test("ArrowDown on Views opens it on its first link, and arrows move between links", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/graph");
    const views = button("Views");
    views.focus();
    key("ArrowDown");
    await settle();
    expect(views.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Shipping log");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Tides board");
  });

  test("focus leaving the button and panel closes it; an Escape already handled does not", async () => {
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/graph");
    const views = button("Views");
    click(views);
    await settle();
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => {
      document.body.dispatchEvent(handled);
    });
    expect(views.getAttribute("aria-expanded")).toBe("true");
    views.focus();
    act(() => link("Graph").focus());
    expect(views.getAttribute("aria-expanded")).toBe("false");
  });
});
