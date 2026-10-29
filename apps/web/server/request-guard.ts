// Request guard (board-visual-reviews review follow-up): the API server binds
// loopback only, but a browser will still carry a page's request to it, and
// since the server runs `bd` on a review decision, that is worth refusing
// before any handler runs. Pure; index.ts's request dispatcher applies it to
// every request (wired in by bd-ker.3, which owns that dispatcher).
//
// Host must be exactly `127.0.0.1:<port>` or `localhost:<port>` (case
// folded). That defeats DNS rebinding: a page on `evil.example` whose name
// is re-pointed at 127.0.0.1 still sends `Host: evil.example:<port>`. The
// Vite dev proxy rewrites Host to the target (`changeOrigin: true` in
// vite.config.ts), so proxied requests pass.
//
// For anything but GET/HEAD, an Origin header, when present, must be
// `http://localhost:<any port>` or `http://127.0.0.1:<any port>` — the Vite
// client's origin is a different port from this server's, so the port is
// not pinned. A cross-site POST from a browser always carries Origin, so a
// foreign page cannot submit a decision even through a loopback Host. An
// absent Origin (curl, the review-request CLI) is allowed: it is not a
// browser acting for another site. GET/HEAD are not checked for Origin:
// they change nothing, and with no CORS headers a foreign page cannot read
// the answer.

export interface GuardedRequest {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;

/** True when the request may reach a handler (module header). */
export function isAllowedRequest(request: GuardedRequest, port: number): boolean {
  const host = request.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  return request.origin === undefined || LOCAL_ORIGIN.test(request.origin.toLowerCase());
}
