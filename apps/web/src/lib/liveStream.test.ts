import { describe, expect, it, vi } from "vitest";
import { createLiveStream, type LiveEvent, type LiveListener, type StreamHandlers, type VisibilitySource } from "./liveStream.js";

/** A fake server stream: records each subscription and lets the test drive its callbacks. */
function fakeServer() {
  const subscriptions: { handlers: StreamHandlers; closed: boolean }[] = [];
  return {
    subscriptions,
    subscribe(handlers: StreamHandlers) {
      const sub = { handlers, closed: false };
      subscriptions.push(sub);
      return { unsubscribe: () => void (sub.closed = true) };
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
});
