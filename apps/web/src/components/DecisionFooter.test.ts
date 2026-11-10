// @vitest-environment jsdom
//
// DecisionFooter's `noteSendsToAgent` mode (inbox-follow-through, design.md
// decision 2): one primary action on a card without options, Accept while the
// message is blank and Send to agent (`changes`) once a note is typed; the
// shortcut follows it; a host without the mode keeps both buttons.

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cardShortcut, DecisionFooter, primaryDecision, type FooterLabels } from "./DecisionCard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(message: string, labels: Partial<FooterLabels>, decide = vi.fn()) {
  act(() => {
    root.render(
      createElement(DecisionFooter, {
        open: true,
        recipient: "the agent",
        sessionLinks: null,
        labels: { acceptLabel: "Accept", changesLabel: "Send to agent", ...labels },
        actions: null,
        message,
        setMessage: () => {},
        messageRef: createRef<HTMLTextAreaElement>(),
        needsMessage: false,
        pending: null,
        pendingOption: null,
        onOptionFocus: () => {},
        optionDescId: (id: string) => `d-${id}`,
        outcome: null,
        refusal: null,
        decide,
      }),
    );
  });
  return decide;
}

function buttons(): string[] {
  return [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

function press(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (button === undefined) throw new Error(`no ${label} button among ${buttons().join(", ")}`);
  act(() => button.click());
}

describe("noteSendsToAgent", () => {
  test("a blank note shows one Accept that accepts", () => {
    const decide = render("  ", { noteSendsToAgent: true });
    expect(buttons()).toEqual(["Accept"]);
    press("Accept");
    expect(decide).toHaveBeenCalledWith("accept");
  });

  test("a typed note turns it into Send to agent, recording changes", () => {
    const decide = render("already sent a message, close this", { noteSendsToAgent: true });
    expect(buttons()).toEqual(["Send to agent"]);
    press("Send to agent");
    expect(decide).toHaveBeenCalledWith("changes");
  });

  test("without the mode both buttons stay, as on the board", () => {
    render("a note", { changesLabel: "Request changes" });
    expect(buttons()).toEqual(["Accept", "Request changes"]);
  });
});

describe("primaryDecision and the shortcut", () => {
  const key = { key: "Enter", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: null };

  test("primaryDecision follows the note only in the mode", () => {
    expect(primaryDecision("", true)).toBe("accept");
    expect(primaryDecision("close it", true)).toBe("changes");
    expect(primaryDecision("close it", false)).toBe("accept");
  });

  test("Ctrl/Cmd+Enter on a plain card follows the note in the mode, and accepts without it", () => {
    expect(cardShortcut(key, null, "", { noteSendsToAgent: true })).toEqual({ kind: "accept" });
    expect(cardShortcut(key, null, "close it", { noteSendsToAgent: true })).toEqual({ kind: "changes" });
    expect(cardShortcut(key, null, "close it")).toEqual({ kind: "accept" });
  });

  test("the Shift variant still sends a typed note and asks for one when blank", () => {
    expect(cardShortcut({ ...key, shiftKey: true }, null, "close it", { noteSendsToAgent: true })).toEqual({ kind: "changes" });
    expect(cardShortcut({ ...key, shiftKey: true }, null, "", { noteSendsToAgent: true })).toEqual({ kind: "needs-message" });
  });
});
