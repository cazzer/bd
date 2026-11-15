// @vitest-environment jsdom
//
// The project switcher (roadmap-milestones tasks.md 3.2): a labelled native
// select offering "All projects" and each offered project, reading the
// address's state, and reporting a choice — with "N projects" shown, never
// offered, for an address naming several.

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

function render(address: string[], onChoose = vi.fn()) {
  act(() => root.render(createElement(ProjectSwitcher, { offered: OFFERED, address, onChoose })));
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

  test("reads N projects for several, as an option that cannot be chosen", () => {
    const { select } = render(["tides", "strides"]);
    const shown = select.selectedOptions[0]!;
    expect(shown.textContent).toBe("2 projects");
    expect(shown.disabled).toBe(true);
    expect(shown.hidden).toBe(true);
  });
});
