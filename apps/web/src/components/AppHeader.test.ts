// @vitest-environment jsdom
//
// The shell header (shared-nav-header tasks.md 1.3-1.5; app-navigation spec
// "Every view shares one header", "The Views menu lists saved views", "The
// chosen project follows the reader", "The header fits a phone"): the nav
// links carry the project and mark the current view, the switcher says when
// a view is not filtered, the Views menu reads once and fails in one line,
// and on a phone the nav collapses into a Menu disclosure. The tRPC client,
// the queue's pill, the status pills, and the project registry are stubbed
// (they have their own tests).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseRoute, type Route } from "../lib/route.js";
import type { ShellProjects } from "../lib/shellNav.js";

const trpcMock = vi.hoisted(() => ({ list: { query: vi.fn() } }));
const navigateMock = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  wideHeader: true,
  wideDrawer: true,
  shellDrawerOpen: false,
  shell: { registry: ["skyos", "tides"], registryFailed: false, boardView: null } as ShellProjects,
}));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));
vi.mock("../lib/navigate.js", () => ({ navigate: navigateMock }));
vi.mock("./ShellProjects.js", () => ({ useShellProjects: () => env.shell }));
vi.mock("./ReviewDrawer.js", () => ({ useWideDrawer: () => env.wideDrawer }));
vi.mock("./ReviewQueue.js", async () => {
  const { createElement: h } = await import("react");
  return { ReviewQueuePill: () => h("button", { type: "button", "data-stub": "review-pill" }, "reviews"), useShellDrawer: () => ({ open: env.shellDrawerOpen, drafts: new Map() }) };
});
vi.mock("./HangarStatusPill.js", () => ({ HangarStatusPill: () => null }));
vi.mock("./RelayStatusPill.js", () => ({ RelayStatusPill: () => null }));

const { AppHeader } = await import("./AppHeader.js");
const { forgetSavedViews } = await import("./ViewsMenu.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  env.wideHeader = true;
  env.wideDrawer = true;
  env.shellDrawerOpen = false;
  env.shell = { registry: ["skyos", "tides"], registryFailed: false, boardView: null };
  navigateMock.mockReset();
  trpcMock.list.query.mockReset();
  forgetSavedViews();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: env.wideHeader, media: query, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
    expect(select.getAttribute("aria-description")).toBe("The inbox is not filtered by project.");
    expect(select.getAttribute("title")).toBe("The inbox is not filtered by project.");
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
    env.wideHeader = false;
    trpcMock.list.query.mockResolvedValue({ nodes: VIEWS, hasMore: false, nextCursor: null });
    render("/inbox?project=tides");
    expect(() => button("Views")).toThrow();
    expect(container.querySelector("select")).not.toBeNull();
    expect(container.querySelector('[data-stub="review-pill"]')).not.toBeNull();

    const menu = button("Menu");
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
    env.wideHeader = false;
    trpcMock.list.query.mockResolvedValue({ nodes: [], hasMore: false, nextCursor: null });
    render("/graph");
    const menu = button("Menu");
    click(menu);
    link("Board").focus();
    key("Escape");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu);
  });
});
