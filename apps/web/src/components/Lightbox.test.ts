// @vitest-environment jsdom
//
// Lightbox stepping (video-review-attachments, design.md decision 7): the
// arrow keys step through the items, except from a <video>, whose own
// controls take them to seek. jsdom has no modal dialogs, so `showModal` and
// `close` are stubbed.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Lightbox, type LightboxItem } from "./Lightbox.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};
HTMLMediaElement.prototype.play = vi.fn(async () => {});
HTMLMediaElement.prototype.pause = vi.fn();

const ITEMS: LightboxItem[] = [
  { kind: "image", name: "shot.png", path: "/r/shot.png", src: "/u/shot.png" },
  { kind: "video", name: "reel.mp4", path: "/r/reel.mp4", src: "/u/reel.mp4", poster: null },
];

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

function render(index: number, onIndexChange: (i: number) => void) {
  act(() => {
    root.render(createElement(Lightbox, { items: ITEMS, index, onIndexChange, onClose: () => {} }));
  });
}

function arrowRight(target: Element): KeyboardEvent {
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(key);
  });
  return key;
}

describe("Lightbox arrow keys", () => {
  test("step from the dialog itself", () => {
    const onIndexChange = vi.fn();
    render(0, onIndexChange);
    const dialog = container.querySelector("dialog")!;
    expect(arrowRight(dialog).defaultPrevented).toBe(true);
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  test("stay with a focused video, never stepping to the next item", () => {
    const onIndexChange = vi.fn();
    render(1, onIndexChange);
    const video = container.querySelector("video")!;
    expect(container.querySelector("dialog")!.getAttribute("aria-label")).toBe("Video 2 of 2: reel.mp4");
    act(() => {
      video.focus();
    });
    const key = arrowRight(video);
    expect(key.defaultPrevented).toBe(false);
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBe(video);
  });
});
