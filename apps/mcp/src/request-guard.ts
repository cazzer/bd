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
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for a loopback socket address: 127.0.0.0/8, `::1`, or an IPv4
 * loopback mapped into IPv6 (`::ffff:127.x.y.z`). http-server.ts checks
 * both the address it bound and each request's peer with it, so loopback
 * holds even if the bind validation in http-config.ts is ever widened.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const lowered = address.toLowerCase();
  if (lowered === "::1") return true;
  const v4 = lowered.startsWith("::ffff:") ? lowered.slice("::ffff:".length) : lowered;
  return LOOPBACK_V4.test(v4);
}

/** True when the request may reach a route (module header). */
export function isAllowedRequest(request: GuardedRequest, port: number): boolean {
  const host = request.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false;
  return request.origin === undefined || LOCAL_ORIGIN.test(request.origin.toLowerCase());
}
