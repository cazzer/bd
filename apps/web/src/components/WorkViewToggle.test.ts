// @vitest-environment jsdom
//
// The Board / Roadmap toggle (roadmap-milestones tasks.md 3.3): two real
// links whose hrefs carry the routes, the current one marked, a plain click
// pushed through navigate, and a modified click left to the browser.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BoardRoute, RoadmapRoute } from "../lib/route.js";
import { WorkViewToggle } from "./WorkViewToggle.js";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/navigate.js", () => ({ navigate: navigateMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigateMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const BOARD: BoardRoute = { view: "board", viewId: null, projects: ["tides"], item: "tides-r1" };
const ROADMAP: RoadmapRoute = { view: "roadmap", projects: ["tides"], item: null };

function render(current: "board" | "roadmap") {
  act(() => root.render(createElement(WorkViewToggle, { current, board: BOARD, roadmap: ROADMAP })));
  const links = [...container.querySelectorAll("a")];
  return { board: links.find((a) => a.textContent === "Board")!, roadmap: links.find((a) => a.textContent === "Roadmap")! };
}

function click(a: HTMLAnchorElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    a.dispatchEvent(event);
  });
  return event;
}

describe("WorkViewToggle", () => {
  test("is a named navigation of two links carrying the routes", () => {
    const { board, roadmap } = render("board");
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Board or roadmap");
    expect(board.getAttribute("href")).toBe("/board?project=tides&item=tides-r1");
    expect(roadmap.getAttribute("href")).toBe("/roadmap?project=tides");
  });

  test("marks the current view with aria-current=page", () => {
    let links = render("board");
    expect(links.board.getAttribute("aria-current")).toBe("page");
    expect(links.roadmap.hasAttribute("aria-current")).toBe(false);
    links = render("roadmap");
    expect(links.roadmap.getAttribute("aria-current")).toBe("page");
    expect(links.board.hasAttribute("aria-current")).toBe(false);
  });

  test("pushes the route on a plain click", () => {
    const { roadmap } = render("board");
    const event = click(roadmap);
    expect(event.defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith(ROADMAP, "push");
  });

  test("leaves a modified or non-primary click to the browser", () => {
    const { roadmap } = render("board");
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = click(roadmap, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
