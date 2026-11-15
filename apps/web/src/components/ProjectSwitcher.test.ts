// @vitest-environment jsdom
//
// The project switcher (roadmap-milestones tasks.md 3.2): a labelled native
// select offering "All projects" and each offered project, reading the
// address's state, and reporting a choice — with the several projects an
// old link names shown, never offered; disabled while the projects load;
// plain text when only one is offered.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ALL_PROJECTS_CHOICE } from "../lib/workViewNav.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const OFFERED = ["skyos", "tides", "strides"];

function render(address: string[], onChoose = vi.fn(), offered: string[] | null = OFFERED, fallback = false) {
  act(() => root.render(createElement(ProjectSwitcher, { offered, address, onChoose, fallback })));
  const select = container.querySelector("select")!;
  return { select, onChoose };
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ProjectSwitcher", () => {
  test("is a select named Project, offering All projects then each project", () => {
    const { select } = render([]);
    expect(select.labels?.[0]?.textContent).toBe("Project");
    expect([...select.options].map((o) => o.textContent)).toEqual(["All projects", "skyos", "tides", "strides"]);
    expect(select.value).toBe(ALL_PROJECTS_CHOICE);
  });

  test("shows the one chosen project and reports another choice", () => {
    const { select, onChoose } = render(["tides"]);
    expect(select.selectedOptions[0]?.textContent).toBe("tides");
    choose(select, "skyos");
    expect(onChoose).toHaveBeenCalledWith("skyos");
    choose(select, ALL_PROJECTS_CHOICE);
    expect(onChoose).toHaveBeenLastCalledWith(ALL_PROJECTS_CHOICE);
  });

  test("names several projects as an option that cannot be chosen", () => {
    const { select } = render(["tides", "strides"]);
    const shown = select.selectedOptions[0]!;
    expect(shown.textContent).toBe("tides + strides");
    expect(shown.disabled).toBe(true);
    expect(shown.hidden).toBe(true);
  });

  test("is disabled while the projects load, reading the address's one key or All projects", () => {
    const { select } = render(["rmf"], vi.fn(), null);
    expect(select.disabled).toBe(true);
    expect([...select.options].map((o) => o.textContent)).toEqual(["rmf"]);
    render([], vi.fn(), null);
    expect(container.querySelector("select")!.selectedOptions[0]?.textContent).toBe("All projects");
  });

  describe("with the registry unreadable (fallback: offered is the address)", () => {
    test("with no project named, is a live menu offering All projects alone", () => {
      const { select } = render([], vi.fn(), [], true);
      expect(select.disabled).toBe(false);
      expect([...select.options].map((o) => o.textContent)).toEqual(["All projects"]);
      expect(select.value).toBe(ALL_PROJECTS_CHOICE);
    });

    test("with one project named, stays a menu (not text) reading it, and offers All projects", () => {
      const { select, onChoose } = render(["rmf"], vi.fn(), ["rmf"], true);
      expect(select.disabled).toBe(false);
      expect(select.selectedOptions[0]?.textContent).toBe("rmf");
      expect([...select.options].map((o) => o.textContent)).toEqual(["All projects", "rmf"]);
      choose(select, ALL_PROJECTS_CHOICE);
      expect(onChoose).toHaveBeenCalledWith(ALL_PROJECTS_CHOICE);
    });

    test("with several named, reads them (not All projects) and offers each one", () => {
      const { select, onChoose } = render(["rmf", "rmb"], vi.fn(), ["rmf", "rmb"], true);
      expect(select.selectedOptions[0]?.textContent).toBe("rmf + rmb");
      expect([...select.options].filter((o) => !o.hidden).map((o) => o.textContent)).toEqual(["All projects", "rmf", "rmb"]);
      choose(select, "rmb");
      expect(onChoose).toHaveBeenCalledWith("rmb");
    });
  });

  test("shows the only offered project as text, with nothing to choose", () => {
    render([], vi.fn(), ["solo"]);
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toBe("Project: solo");
  });
});
