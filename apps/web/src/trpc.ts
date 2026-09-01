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

import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../server/router.js";

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      // Relative: the browser only ever talks to this dev server's own
      // origin. vite.config.ts proxies this path to the loopback-only
      // tRPC server — the browser never learns its port.
      url: "/trpc",
    }),
  ],
});
