import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadScheduler } from "./readScheduler.js";

/** A read the test finishes by hand, so overlap is observable. */
function controlledRead() {
  const pending: (() => void)[] = [];
  let calls = 0;
  return {
    read: () => {
      calls++;
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    calls: () => calls,
    inFlight: () => pending.length,
    async finish() {
      pending.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createReadScheduler", () => {
  it("collapses a burst of requests into one read, debounceMs after the last", async () => {
    const r = controlledRead();
    const s = createReadScheduler({ read: r.read, debounceMs: 150, maxWaitMs: 1000 });
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    s.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.calls()).toBe(1);
  });

  it("cannot be deferred past maxWaitMs by a continuous stream", async () => {
    const r = controlledRead();
    const s = createReadScheduler({ read: r.read, debounceMs: 150, maxWaitMs: 1000 });
    for (let t = 0; t < 1000; t += 100) {
      s.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(r.calls()).toBe(1);
  });

  it("never overlaps reads: requests during a read run exactly one follow-up", async () => {
    const r = controlledRead();
    const busy: boolean[] = [];
    const s = createReadScheduler({ read: r.read, debounceMs: 150, maxWaitMs: 1000, onBusyChange: (b) => busy.push(b) });
    s.run();
    s.run();
    s.run();
    expect(r.calls()).toBe(1);
    await r.finish();
    expect(r.calls()).toBe(2);
    expect(r.inFlight()).toBe(1);
    await r.finish();
    expect(r.calls()).toBe(2);
    expect(busy).toEqual([true, false]);
  });

  it("run cancels a pending debounced read", async () => {
    const r = controlledRead();
    const s = createReadScheduler({ read: r.read, debounceMs: 150, maxWaitMs: 1000 });
    s.schedule();
    s.run();
    await r.finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.calls()).toBe(1);
  });

  it("dispose cancels the timer and any follow-up read", async () => {
    const r = controlledRead();
    const s = createReadScheduler({ read: r.read, debounceMs: 150, maxWaitMs: 1000 });
    s.run();
    s.run();
    s.dispose();
    await r.finish();
    s.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(r.calls()).toBe(1);
  });
});
