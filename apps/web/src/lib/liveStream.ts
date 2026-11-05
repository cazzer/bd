// The tab's one live change stream (review-queue, design.md decision 2). The
// board and the review queue both stay current from the server's
// `boardEvents` subscription; this module holds that subscription once for
// the whole tab behind a listener registry, so two readers never mean two
// connections.
//
// The subscription exists while at least one listener is registered and the
// page is not hidden, and not otherwise. Every open tab's stream is a
// long-lived connection, and Chrome allows six HTTP/1.1 connections per
// host, so enough tabs starve every other request to the server — a review
// decision's POST queues behind them forever. The page's visibility is
// therefore an input to the registry: a hidden tab drops the stream, and a
// tab shown again subscribes afresh, whose `onStarted` read catches
// everything that changed while it was hidden. Readers keep what they last
// read on screen meanwhile.
//
// Every (re)start calls each listener's `onStarted` — the tRPC SSE link
// calls it on every (re)connection, so a reconnect and a shown-again tab
// both re-read. A listener that registers while the stream is already
// started gets `onStarted` at once, synchronously inside `subscribe`: it has
// missed nothing it could not read now. Listeners subscribe first and read
// in `onStarted`, so a change that lands between a read and the stream
// cannot be missed.
//
// A stream that fails (`onError`, e.g. no watcher on this server) is gone
// until the next start; the state reads `offline` and every listener's
// `onError` is called so it can still do its one read — the board's and the
// queue's readers do exactly that. A listener that registers while the
// stream is failed gets `onError` with the same error at once. The next
// start (the tab shown again, or a first listener after the last left)
// tries again.
//
// `createLiveStream(deps)` is the registry over an injected subscribe
// function and document, so it is testable without React or a tRPC client;
// `subscribeLive` and `useLiveState` are the tab's default instance over
// `trpc.boardEvents`.

import { useSyncExternalStore } from "react";
import type { BeadsWatcherEvent } from "../../server/beads-watcher.js";
import { trpc } from "../trpc.js";

export type LiveEvent = BeadsWatcherEvent;
export type LiveState = "connecting" | "live" | "offline";

export interface LiveListener {
  onStarted: () => void;
  onEvent: (event: LiveEvent) => void;
  onError?: (err: unknown) => void;
}

/** The slice of a tRPC subscription observer the registry drives. */
export interface StreamHandlers {
  onStarted: () => void;
  onData: (event: LiveEvent) => void;
  onConnectionStateChange: (state: { state: string }) => void;
  onError: (err: unknown) => void;
}

/** The slice of `document` the registry reads. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface LiveStreamDeps {
  subscribe: (handlers: StreamHandlers) => { unsubscribe: () => void };
  /** Absent outside a browser: the page counts as always shown. */
  document?: VisibilitySource;
}

export interface LiveStream {
  subscribe(listener: LiveListener): () => void;
  getState(): LiveState;
  onStateChange(callback: () => void): () => void;
}

export function createLiveStream(deps: LiveStreamDeps): LiveStream {
  const listeners = new Set<LiveListener>();
  const stateCallbacks = new Set<() => void>();
  let subscription: { unsubscribe: () => void } | null = null;
  /** Bumped on every start and stop, so a stale subscription's callbacks are ignored. */
  let generation = 0;
  let started = false;
  let failure: { err: unknown } | null = null;
  let state: LiveState = "connecting";

  function setState(next: LiveState) {
    if (next === state) return;
    state = next;
    for (const callback of [...stateCallbacks]) callback();
  }

  function shown(): boolean {
    return deps.document === undefined || deps.document.visibilityState !== "hidden";
  }

  function start() {
    const mine = ++generation;
    started = false;
    failure = null;
    setState("connecting");
    const current = () => mine === generation;
    subscription = deps.subscribe({
      onStarted: () => {
        if (!current()) return;
        started = true;
        for (const l of [...listeners]) if (listeners.has(l)) l.onStarted();
      },
      onData: (event) => {
        if (!current()) return;
        for (const l of [...listeners]) if (listeners.has(l)) l.onEvent(event);
      },
      onConnectionStateChange: ({ state: s }) => {
        if (!current()) return;
        if (s === "connecting") started = false;
        setState(s === "pending" ? "live" : s === "connecting" ? "connecting" : "offline");
      },
      onError: (err) => {
        if (!current()) return;
        generation++;
        subscription?.unsubscribe();
        subscription = null;
        started = false;
        failure = { err };
        setState("offline");
        for (const l of [...listeners]) if (listeners.has(l)) l.onError?.(err);
      },
    });
  }

  function stop() {
    generation++;
    subscription?.unsubscribe();
    subscription = null;
    started = false;
    failure = null;
    setState("connecting");
  }

  /** Bring the subscription in line with the rule: exists iff listeners > 0 and the page is shown. */
  function reconcile() {
    const wanted = listeners.size > 0 && shown();
    const holding = subscription !== null || failure !== null;
    if (wanted && !holding) start();
    else if (!wanted && holding) stop();
  }

  const onVisibilityChange = () => reconcile();

  return {
    subscribe(listener) {
      const wrapped: LiveListener = { ...listener };
      if (listeners.size === 0) deps.document?.addEventListener("visibilitychange", onVisibilityChange);
      listeners.add(wrapped);
      if (subscription === null && failure === null) reconcile();
      else if (started) wrapped.onStarted();
      else if (failure !== null) wrapped.onError?.(failure.err);
      return () => {
        if (!listeners.delete(wrapped)) return;
        if (listeners.size === 0) deps.document?.removeEventListener("visibilitychange", onVisibilityChange);
        reconcile();
      };
    },
    getState: () => state,
    onStateChange(callback) {
      stateCallbacks.add(callback);
      return () => stateCallbacks.delete(callback);
    },
  };
}

const tabStream = createLiveStream({
  subscribe: (handlers) => trpc.boardEvents.subscribe(undefined, handlers),
  document: typeof document === "undefined" ? undefined : document,
});

/** Register with the tab's one live stream; returns the unsubscribe. */
export function subscribeLive(listener: LiveListener): () => void {
  return tabStream.subscribe(listener);
}

/** The tab's live stream state: `live` while connected, `connecting`, or `offline` after a failure. */
export function useLiveState(): LiveState {
  return useSyncExternalStore(tabStream.onStateChange, tabStream.getState, tabStream.getState);
}
