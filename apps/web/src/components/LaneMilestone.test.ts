// @vitest-environment jsdom
//
// The lane header's milestone label (roadmap-milestones tasks.md 3.4): the
// title shown, "milestone" said to screen readers, the glyph hidden.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { LaneMilestone } from "./LaneMilestone.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("names the milestone, with 'milestone' for screen readers only", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(LaneMilestone, { title: "Beta launch" })));
  const label = container.querySelector("[data-lane-milestone]")!;
  expect(label.textContent).toBe("◇ milestone Beta launch");
  expect(label.querySelector(".sr-only")?.textContent).toBe("milestone ");
  expect(label.querySelector('[aria-hidden="true"]')?.textContent).toBe("◇ ");
  act(() => root.unmount());
});
