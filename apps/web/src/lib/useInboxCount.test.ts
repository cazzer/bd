// @vitest-environment jsdom
//
// The shell header's inbox count (shared-nav-header tasks.md 2.2): it reads
// the pending items on InboxView's cadence, counts what Needs me lists from
// the inbox (no reviews), stops while the tab is hidden and reads at once
// when it shows again, and a failed read hides the count. The tRPC client
// is mocked; timers are fake.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const trpcMock = vi.hoisted(() => ({ inbox: { query: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

const { useInboxCount } = await import("./useInboxCount.js");
const { INBOX_POLL_MS } = await import("./inboxRows.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, status: string, parentId: string | null = null) => ({ id, status, parentId });

let container: HTMLDivElement;
let root: Root;
let hidden = false;
let shown: number | null | undefined;

function Probe() {
  shown = useInboxCount();
  return null;
}

function setHidden(next: boolean) {
  hidden = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  shown = undefined;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  trpcMock.inbox.query.mockReset();
  trpcMock.inbox.query.mockResolvedValue({ items: [item("a", "pending"), item("b", "pending"), item("kid", "pending", "a")], total: 3, truncated: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (document as { hidden?: boolean }).hidden;
});

describe("useInboxCount", () => {
  test("reads the pending items at once and counts Needs me's top-level ones", async () => {
    act(() => root.render(createElement(Probe)));
    expect(shown).toBeNull();
    await flush();
    expect(trpcMock.inbox.query).toHaveBeenCalledWith({ statuses: ["pending"] });
    expect(shown).toBe(2);
  });

  test("re-reads every 15 s, pauses while hidden, and reads at once when shown again", async () => {
    act(() => root.render(createElement(Probe)));
    await flush();
    expect(trpcMock.inbox.query).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    expect(trpcMock.inbox.query).toHaveBeenCalledTimes(2);

    setHidden(true);
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS * 4);
    });
    expect(trpcMock.inbox.query).toHaveBeenCalledTimes(2);

    trpcMock.inbox.query.mockResolvedValue({ items: [item("a", "pending")], total: 1, truncated: false });
    setHidden(false);
    await flush();
    expect(trpcMock.inbox.query).toHaveBeenCalledTimes(3);
    expect(shown).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    expect(trpcMock.inbox.query).toHaveBeenCalledTimes(4);
  });

  test("does not read while the tab starts hidden", async () => {
    hidden = true;
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS * 2);
    });
    expect(trpcMock.inbox.query).not.toHaveBeenCalled();
    expect(shown).toBeNull();
  });

  test("a failed read hides the count until a read succeeds", async () => {
    act(() => root.render(createElement(Probe)));
    await flush();
    expect(shown).toBe(2);
    trpcMock.inbox.query.mockRejectedValueOnce(new Error("connection refused"));
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    await flush();
    expect(shown).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(INBOX_POLL_MS);
    });
    await flush();
    expect(shown).toBe(2);
  });
});
