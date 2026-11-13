// Request admission for both HTTP servers, the web API and MCP
// (tailnet-hosting, design decision 2). This is the one adapter piece the
// two servers share rather than copy: the earlier per-server guards drifted
// (the web copy had no `[::1]`, and only MCP checked Origin on GET), and a
// drift in this function is a hole in the boundary, not a cosmetic
// difference. Everything else in the adapters stays copy-not-share.
//
// Pure apart from `policy.verifyToken`, which the adapter wires to the
// token store (client-tokens.ts). The decision, in order:
//
// 1. `Host` (case folded) must be `<name>:<port>` for a loopback name or an
//    operator-allowed host. Anything else is 403, token or not: DNS
//    rebinding needs only a browser and a cookie, so a credential never
//    excuses a foreign Host.
// 2. An `Origin`, when present on a checked method, must be http(s) with a
//    loopback or allowed hostname (any port). The web checks only unsafe
//    methods; MCP checks every method, because GET opens its SSE stream.
//    `Origin: null` (a sandboxed or opaque origin) is refused.
// 3. A loopback peer with a loopback `Host` is trusted with no token —
//    today's local path. Both conditions are needed: a loopback peer
//    sending a tailnet `Host` is a local proxy hiding the real caller.
// 4. A public path (`policy.isPublic`) is admitted with no token.
// 5. Otherwise a credential is required: missing, unknown, or revoked is
//    401. A cookie on a checked method without an `Origin` is 403, since a
//    cookie is ambient and only the Origin shows who sent it.
//
// `path` is the raw request-target with the query stripped, deliberately
// not URL-normalized: a public-path predicate must match exactly what the
// router will route, never a normalized spelling of it.

import { isIPv6 } from "node:net";

export const LOOPBACK_HOST_NAMES = ["127.0.0.1", "localhost", "[::1]"] as const;
export const TOKEN_COOKIE_NAME = "breakdown_token";
export const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": "Bearer" } as const;

export interface PresentedCredential {
  token: string;
  source: "bearer" | "cookie";
}

export interface AdmissionRequest {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  peerIsLoopback: boolean;
  /** Raw request-target, query stripped, NOT URL-normalized (module header). */
  path: string;
  credential: PresentedCredential | undefined;
}

export interface AdmissionPolicy {
  port: number;
  /** Each already passed through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
  /** `unsafe-methods` for the web API, `all-methods` for MCP. */
  originCheck: "unsafe-methods" | "all-methods";
  /** `method` arrives upper-cased. */
  isPublic?: (method: string, path: string) => boolean;
  /** The client a live token belongs to, or null. */
  verifyToken: (token: string) => Promise<string | null>;
}

export type Admission =
  | { outcome: "allow"; client: string | null }
  | { outcome: "forbidden" }
  | { outcome: "unauthorized" };

const FORBIDDEN: Admission = { outcome: "forbidden" };
const UNAUTHORIZED: Admission = { outcome: "unauthorized" };
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(LOOPBACK_HOST_NAMES);

/** Decides whether a request may reach a handler (module header). */
export async function admitRequest(req: AdmissionRequest, policy: AdmissionPolicy): Promise<Admission> {
  const hostName = matchHost(req.host, policy);
  if (hostName === undefined) return FORBIDDEN;

  const method = (req.method ?? "GET").toUpperCase();
  const originChecked = policy.originCheck === "all-methods" || (method !== "GET" && method !== "HEAD");
  if (originChecked && req.origin !== undefined && !isAllowedOrigin(req.origin, policy)) return FORBIDDEN;

  if (req.peerIsLoopback && LOOPBACK_NAMES.has(hostName)) return { outcome: "allow", client: null };
  if (policy.isPublic?.(method, req.path)) return { outcome: "allow", client: null };

  if (req.credential === undefined) return UNAUTHORIZED;
  if (req.credential.source === "cookie" && originChecked && req.origin === undefined) return FORBIDDEN;
  const client = await policy.verifyToken(req.credential.token);
  return client === null ? UNAUTHORIZED : { outcome: "allow", client };
}

/** The loopback or allowed name the Host header carries at the policy's port, or undefined. */
function matchHost(host: string | undefined, policy: AdmissionPolicy): string | undefined {
  if (host === undefined) return undefined;
  const lowered = host.toLowerCase();
  const suffix = `:${policy.port}`;
  if (!lowered.endsWith(suffix)) return undefined;
  const name = lowered.slice(0, -suffix.length);
  return LOOPBACK_NAMES.has(name) || policy.allowedHosts.includes(name) ? name : undefined;
}

function isAllowedOrigin(origin: string, policy: AdmissionPolicy): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // An Origin header is scheme://host[:port] and nothing more.
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }
  return LOOPBACK_NAMES.has(url.hostname) || policy.allowedHosts.includes(url.hostname);
}

/**
 * The token a request presents: an `Authorization: Bearer` header first,
 * then the connect flow's cookie. Never the URL — a token in a query string
 * ends up in logs and history, so it is treated as no token at all.
 */
export function credentialFrom(headers: {
  authorization?: string | string[];
  cookie?: string | string[];
}): PresentedCredential | undefined {
  const authorizations = headers.authorization === undefined ? [] : [headers.authorization].flat();
  for (const value of authorizations) {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
    if (match) return { token: match[1] as string, source: "bearer" };
  }
  const cookies = headers.cookie === undefined ? [] : [headers.cookie].flat();
  for (const header of cookies) {
    for (const pair of header.split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.slice(0, eq).trim() !== TOKEN_COOKIE_NAME) continue;
      const token = pair.slice(eq + 1).trim();
      if (token !== "") return { token, source: "cookie" };
    }
  }
  return undefined;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for a loopback socket address: 127.0.0.0/8, `::1`, or an IPv4
 * loopback mapped into IPv6 (`::ffff:127.x.y.z`).
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const lowered = address.toLowerCase();
  if (lowered === "::1") return true;
  const v4 = lowered.startsWith("::ffff:") ? lowered.slice("::ffff:".length) : lowered;
  return LOOPBACK_V4.test(v4);
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * An operator's `--allow-host` value in the form `admitRequest` compares:
 * a lowercased hostname, an IPv4 address, or a bracketed IPv6 address
 * (canonicalized as a URL would spell it, so it matches an Origin). Throws
 * on anything else — a port (the server's own port is implied), a scheme,
 * a path, a wildcard, or nothing — so a mistyped flag fails at startup
 * rather than silently admitting nothing.
 */
export function normalizeAllowedHost(value: string): string {
  const lowered = value.trim().toLowerCase();
  const refuse = (why: string): never => {
    throw new Error(`invalid allowed host ${JSON.stringify(value)}: ${why}`);
  };
  if (lowered === "") refuse("it is empty");
  if (lowered.includes("*")) refuse("wildcards are not supported; name each host");
  if (lowered.includes("://")) refuse("give a bare hostname, not a URL with a scheme");
  if (lowered.includes("/")) refuse("give a bare hostname, without a path");
  if (lowered.startsWith("[")) {
    const close = lowered.indexOf("]");
    if (close !== lowered.length - 1) refuse("give a bracketed IPv6 address without a port");
    const inner = lowered.slice(1, -1);
    if (!isIPv6(inner)) refuse("the bracketed value is not an IPv6 address");
    return new URL(`http://${lowered}`).hostname;
  }
  if (lowered.includes(":")) {
    refuse("give the host without a port (the server's own port is implied), and an IPv6 address in brackets");
  }
  if (!HOSTNAME.test(lowered)) refuse("it is not a hostname or IPv4 address");
  return lowered;
}
