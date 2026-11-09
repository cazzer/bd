// Request guard for HTTP mode (brain-mcp spec, "HTTP mode is local only";
// design.md decision 5). A copy of apps/web/server/request-guard.ts's
// isAllowedRequest, per the adapters' copy-not-share convention, pinned to
// the MCP port and applied by http-server.ts to every request — /mcp and
// /healthz alike — before any routing. Pure.
//
// Host must be exactly `127.0.0.1:<port>`, `localhost:<port>`, or
// `[::1]:<port>` (case folded). That defeats DNS rebinding: a page on
// `evil.example` whose name is re-pointed at 127.0.0.1 still sends
// `Host: evil.example:<port>`.
//
// An Origin header, when present, must be `http://localhost:<any port>`,
// `http://127.0.0.1:<any port>`, or `http://[::1]:<any port>`. Unlike the
// web guard, Origin is checked on EVERY method, GET included: a GET on
// /mcp opens the session's SSE stream, so it is not the harmless read it
// is on the web API. An absent Origin (Claude Code, Codex, curl) is
// allowed: it is not a browser acting for another site.

// No method field: the decision does not depend on it (header above).
export interface GuardedRequest {
  host: string | undefined;
  origin: string | undefined;
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

/** True when the request may reach a route (module header). */
export function isAllowedRequest(request: GuardedRequest, port: number): boolean {
  const host = request.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false;
  return request.origin === undefined || LOCAL_ORIGIN.test(request.origin.toLowerCase());
}
