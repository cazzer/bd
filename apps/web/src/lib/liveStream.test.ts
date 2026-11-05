import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStream, RESTART_BASE_MS, RESTART_STABLE_MS, type LiveEvent, type LiveListener, type StreamHandlers, type VisibilitySource } from "./liveStream.js";

/** A fake server stream: records each subscription and lets the test drive its callbacks. */
function fakeServer() {
  const subscriptions: { handlers: StreamHandlers; closed: boolean }[] = [];
  return {
    subscriptions,
    subscribe(handlers: StreamHandlers) {
      const sub = { handlers, closed: false };
      subscriptions.push(sub);
      // Like tRPC's, an unsubscribe completes the observer.
      return {
        unsubscribe: () => {
          if (sub.closed) return;
          sub.closed = true;
          handlers.onComplete();
        },
      };
    },
    open() {
      return subscriptions.filter((s) => !s.closed);
    },
    /** The one open subscription; fails the test when there is not exactly one. */
    current() {
      const open = subscriptions.filter((s) => !s.closed);
      expect(open).toHaveLength(1);
      return open[0]!.handlers;
    },
  };
}

function fakeDocument(initial: "visible" | "hidden" = "visible") {
  let callbacks: (() => void)[] = [];
  const doc: VisibilitySource & { set(v: "visible" | "hidden"): void; listenerCount(): number } = {
    visibilityState: initial,
    addEventListener: (_type, cb) => void callbacks.push(cb),
    removeEventListener: (_type, cb) => void (callbacks = callbacks.filter((c) => c !== cb)),
    set(v) {
      (this as { visibilityState: string }).visibilityState = v;
      for (const cb of [...callbacks]) cb();
    },
    listenerCount: () => callbacks.length,
  };
  return doc;
}

function listener() {
  return {
    onStarted: vi.fn<() => void>(),
    onEvent: vi.fn<(event: LiveEvent) => void>(),
    onError: vi.fn<(err: unknown) => void>(),
  } satisfies LiveListener;
}

const CHANGED: LiveEvent = { kind: "changed", project: "p", changedNodeIds: ["n1"], at: "2026-11-05T00:00:00.000Z" };

describe("createLiveStream", () => {
  it("holds one subscription for any number of listeners and fans events out to each", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    const a = listener();
    const b = listener();
    const c = listener();
    stream.subscribe(a);
    stream.subscribe(b);
    stream.subscribe(c);
    expect(server.subscriptions).toHaveLength(1);

    server.current().onStarted();
    server.current().onData(CHANGED);
    for (const l of [a, b, c]) {
      expect(l.onStarted).toHaveBeenCalledTimes(1);
      expect(l.onEvent).toHaveBeenCalledWith(CHANGED);
    }
  });

  it("holds no subscription while the page is hidden, and none for no listeners", () => {
    const server = fakeServer();
    const doc = fakeDocument("hidden");
    const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
    expect(server.subscriptions).toHaveLength(0);
    const a = listener();
    stream.subscribe(a);
    expect(server.subscriptions).toHaveLength(0);
    expect(a.onStarted).not.toHaveBeenCalled();
  });

  it("drops the stream on hide and, on show, subscribes afresh and calls every onStarted", () => {
    const server = fakeServer();
    const doc = fakeDocument();
    const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
    const a = listener();
    const b = listener();
    stream.subscribe(a);
    stream.subscribe(b);
    server.current().onStarted();

    doc.set("hidden");
    expect(server.open()).toHaveLength(0);

    doc.set("visible");
    expect(server.subscriptions).toHaveLength(2);
    server.current().onStarted();
    expect(a.onStarted).toHaveBeenCalledTimes(2);
    expect(b.onStarted).toHaveBeenCalledTimes(2);
  });

  it("ignores callbacks from a subscription it has dropped", () => {
    const server = fakeServer();
    const doc = fakeDocument();
    const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
    const a = listener();
    stream.subscribe(a);
    const stale = server.current();
    doc.set("hidden");
    stale.onStarted();
    stale.onData(CHANGED);
    expect(a.onStarted).not.toHaveBeenCalled();
    expect(a.onEvent).not.toHaveBeenCalled();
  });

  it("calls a late joiner's onStarted at once when the stream is already started, and not before", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    stream.subscribe(listener());
    const early = listener();
    stream.subscribe(early);
    expect(early.onStarted).not.toHaveBeenCalled();

    server.current().onStarted();
    const late = listener();
    stream.subscribe(late);
    expect(late.onStarted).toHaveBeenCalledTimes(1);
    expect(server.subscriptions).toHaveLength(1);
  });

  it("closes the stream on the last unsubscribe, and reopens for a new listener", () => {
    const server = fakeServer();
    const doc = fakeDocument();
    const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
    const offA = stream.subscribe(listener());
    const offB = stream.subscribe(listener());
    offA();
    expect(server.open()).toHaveLength(1);
    offB();
    expect(server.open()).toHaveLength(0);
    expect(doc.listenerCount()).toBe(0);

    stream.subscribe(listener());
    expect(server.subscriptions).toHaveLength(2);
    expect(server.open()).toHaveLength(1);
  });

  it("fans a reconnect's onStarted out to every listener, and a listener joining mid-reconnect waits for it", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    const a = listener();
    const b = listener();
    stream.subscribe(a);
    stream.subscribe(b);
    const sub = server.current();
    sub.onStarted();
    sub.onConnectionStateChange({ state: "pending" });
    expect(stream.getState()).toBe("live");

    sub.onConnectionStateChange({ state: "connecting" });
    expect(stream.getState()).toBe("connecting");
    const joiner = listener();
    stream.subscribe(joiner);
    expect(joiner.onStarted).not.toHaveBeenCalled();

    sub.onStarted();
    expect(a.onStarted).toHaveBeenCalledTimes(2);
    expect(b.onStarted).toHaveBeenCalledTimes(2);
    expect(joiner.onStarted).toHaveBeenCalledTimes(1);
    expect(server.subscriptions).toHaveLength(1);
  });

  it("reads offline after a failure, tells every listener, tells a later joiner, and retries on the next show", () => {
    const server = fakeServer();
    const doc = fakeDocument();
    const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
    const a = listener();
    stream.subscribe(a);
    const failure = new Error("no watcher");
    server.current().onError(failure);
    expect(stream.getState()).toBe("offline");
    expect(a.onError).toHaveBeenCalledWith(failure);
    expect(server.open()).toHaveLength(0);

    const late = listener();
    stream.subscribe(late);
    expect(late.onError).toHaveBeenCalledWith(failure);
    expect(server.subscriptions).toHaveLength(1);

    doc.set("hidden");
    doc.set("visible");
    expect(server.subscriptions).toHaveLength(2);
    expect(stream.getState()).toBe("connecting");
  });

  it("notifies state observers on each change", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    const seen: string[] = [];
    stream.onStateChange(() => seen.push(stream.getState()));
    stream.subscribe(listener());
    server.current().onConnectionStateChange({ state: "pending" });
    server.current().onConnectionStateChange({ state: "idle" });
    expect(seen).toEqual(["live", "offline"]);
  });

  it("counts the page as shown with no document", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe });
    stream.subscribe(listener());
    expect(server.subscriptions).toHaveLength(1);
  });

  describe("a stream the server ends cleanly", () => {
    afterEach(() => vi.useRealTimers());

    /** What tRPC's SSE link does when the server's generator returns. */
    function serverEnds(handlers: StreamHandlers) {
      handlers.onStopped();
      handlers.onConnectionStateChange({ state: "idle" });
      handlers.onComplete();
    }

    it("is reopened after the backoff, and the new stream's onStarted reaches every listener", () => {
      vi.useFakeTimers();
      const server = fakeServer();
      const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
      const a = listener();
      const b = listener();
      stream.subscribe(a);
      stream.subscribe(b);
      server.current().onStarted();
      server.current().onConnectionStateChange({ state: "pending" });

      serverEnds(server.current());
      expect(server.open()).toHaveLength(0);
      expect(stream.getState()).toBe("connecting");
      vi.advanceTimersByTime(RESTART_BASE_MS - 1);
      expect(server.subscriptions).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(server.subscriptions).toHaveLength(2);

      server.current().onStarted();
      expect(a.onStarted).toHaveBeenCalledTimes(2);
      expect(b.onStarted).toHaveBeenCalledTimes(2);
    });

    it("backs off doubling when every stream ends at once, and resets after a stable stream", () => {
      vi.useFakeTimers();
      const server = fakeServer();
      const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
      stream.subscribe(listener());
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        const before = server.subscriptions.length;
        serverEnds(server.current());
        let waited = 0;
        while (server.subscriptions.length === before) {
          vi.advanceTimersByTime(100);
          waited += 100;
        }
        waits.push(waited);
      }
      expect(waits).toEqual([RESTART_BASE_MS, 2 * RESTART_BASE_MS, 4 * RESTART_BASE_MS]);

      vi.advanceTimersByTime(RESTART_STABLE_MS);
      serverEnds(server.current());
      vi.advanceTimersByTime(RESTART_BASE_MS);
      expect(server.subscriptions).toHaveLength(5);
    });

    it("does not restart after its own unsubscribe, and a hide cancels a pending restart", () => {
      vi.useFakeTimers();
      const server = fakeServer();
      const doc = fakeDocument();
      const stream = createLiveStream({ subscribe: server.subscribe, document: doc });
      const off = stream.subscribe(listener());
      off();
      vi.advanceTimersByTime(60_000);
      expect(server.subscriptions).toHaveLength(1);

      stream.subscribe(listener());
      serverEnds(server.current());
      doc.set("hidden");
      vi.advanceTimersByTime(60_000);
      expect(server.subscriptions).toHaveLength(2);
      doc.set("visible");
      expect(server.subscriptions).toHaveLength(3);
      expect(server.open()).toHaveLength(1);
    });
  });

  it("does not keep a subscription that failed synchronously inside subscribe", () => {
    const opened: { closed: boolean }[] = [];
    const failure = new Error("refused");
    const stream = createLiveStream({
      subscribe: (handlers) => {
        const sub = { closed: false };
        opened.push(sub);
        handlers.onError(failure);
        return { unsubscribe: () => void (sub.closed = true) };
      },
    });
    const a = listener();
    stream.subscribe(a);
    expect(a.onError).toHaveBeenCalledWith(failure);
    expect(stream.getState()).toBe("offline");
    expect(opened[0]!.closed).toBe(true);
  });

  it("tolerates listeners subscribing and unsubscribing from inside onStarted", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    const joiner = listener();
    const other = listener();
    let offSelf = () => {};
    const leaver: LiveListener = {
      onStarted: () => {
        stream.subscribe(joiner);
        offSelf();
      },
      onEvent: () => {},
    };
    offSelf = stream.subscribe(leaver);
    const offOther = stream.subscribe(other);
    server.current().onStarted();
    expect(joiner.onStarted).toHaveBeenCalledTimes(1);
    expect(other.onStarted).toHaveBeenCalledTimes(1);
    expect(server.open()).toHaveLength(1);

    server.current().onData(CHANGED);
    expect(joiner.onEvent).toHaveBeenCalledTimes(1);
    offOther();
    expect(server.open()).toHaveLength(1);
  });

  it("tolerates listeners subscribing and unsubscribing from inside onError", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    const joiner = listener();
    const after = listener();
    let offSelf = () => {};
    const leaver: LiveListener = {
      onStarted: () => {},
      onEvent: () => {},
      onError: () => {
        stream.subscribe(joiner);
        offSelf();
      },
    };
    offSelf = stream.subscribe(leaver);
    stream.subscribe(after);
    const failure = new Error("gone");
    server.current().onError(failure);
    expect(joiner.onError).toHaveBeenCalledTimes(1);
    expect(after.onError).toHaveBeenCalledTimes(1);
    expect(server.open()).toHaveLength(0);
    expect(stream.getState()).toBe("offline");
  });

  it("closes the stream when the last listener leaves from inside onStarted", () => {
    const server = fakeServer();
    const stream = createLiveStream({ subscribe: server.subscribe, document: fakeDocument() });
    let off = () => {};
    off = stream.subscribe({ onStarted: () => off(), onEvent: () => {} });
    server.current().onStarted();
    expect(server.open()).toHaveLength(0);
  });
});
