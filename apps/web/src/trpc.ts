// The typed tRPC client (bd-hmd.3). `AppRouter` is imported as a type
// only, directly from the server's own router definition next door — no
// code generation, no schema sync step. This relative import is the
// entire proof of "end-to-end inference": change a procedure's return
// shape on the server and this file's inferred call sites break at
// typecheck time. See the ticket report for the verbatim error this
// produces.
//
// No React Query layer (no @trpc/react-query, no @tanstack/react-query):
// this ticket's client is a search box and a plain list, one query at a
// time — a vanilla client called from a `useState`-driven effect covers
// that with two fewer dependencies. Revisit if bd-hmd.4/.6 need caching,
// background refetch, or optimistic mutations across many call sites.

import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import type { AppRouter } from "../server/router.js";
import { markAuthorized, markUnauthorized } from "./lib/connection.js";

/** A response that is neither the server's JSON nor ok: its HTTP status, kept on the error tRPC wraps (`cause`). */
export class HttpStatusError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HttpStatusError";
  }
}

// tRPC parses every response as JSON and drops the response when that
// fails, so a proxy's or a crashed server's plain-text 500 would surface as
// "Unexpected token…" with no status. Failing such a response here keeps
// the status for a caller that must tell "refused" from "may have been
// written" (ReviewItemPanel's decision).
//
// A 401 means this browser holds no live client token (tailnet-hosting
// decision 5): it flips the connect gate. Only this link sees it — the SSE
// subscription link gets no status code — so the board's first query is
// what brings the connect screen up. An ok response retires the connect
// screen's "did the cookie stick" marker.
export async function fetchKeepingStatus(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) markUnauthorized();
  else if (res.ok) markAuthorized();
  if (!res.ok && !(res.headers.get("content-type") ?? "").includes("json")) throw new HttpStatusError(res.status, res.statusText);
  return res;
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    // Subscriptions (the live board's change stream) travel as SSE;
    // queries and mutations stay batched.
    splitLink({
      condition: (op) => op.type === "subscription",
      // Relative: the browser only ever talks to this dev server's own
      // origin. vite.config.ts proxies this path to the loopback-only
      // tRPC server — the browser never learns its port.
      true: httpSubscriptionLink({ url: "/trpc" }),
      false: httpBatchLink({ url: "/trpc", fetch: fetchKeepingStatus }),
    }),
  ],
});
