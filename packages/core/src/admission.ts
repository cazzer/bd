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
// 1. `Host` (case folded, a bracketed IPv6 address canonicalized) must be
//    `<loopback name>:<port>`, or an operator-allowed name either at
//    `:<port>` or bare (a fronting proxy such as `tailscale serve` on its
//    scheme's default port sends no port). A loopback name always needs
//    the port. Anything else is 403, token or not: DNS rebinding needs only
//    a browser and a cookie, so a credential never excuses a foreign Host.
// 2. An `Origin`, when present on a checked method, must be http(s) and
//    either a loopback name (any port: the Vite client) or an allowed name
//    at one of the authorities step 1 accepts for it — `:<port>`, or the
//    scheme's default port. That pins writes to this server's own origin:
//    a page on another port of the same tailnet host is a different
//    origin. The web checks only unsafe methods; MCP checks every method,
//    because GET opens its SSE stream. `Origin: null` is refused.
// 3. A loopback peer with a loopback `Host` is trusted with no token —
//    today's local path — unless a forwarding header (`X-Forwarded-For`,
//    `X-Real-IP`, `Forwarded`) names any address that is not loopback: a
//    local proxy acting for a remote caller is not the local machine. A
//    loopback peer sending a tailnet `Host` is likewise a proxy and gets no
//    trust. An L4 forwarder (socat, `ssh -R`) adds no header and cannot be
//    told apart from a local client; the operator must not run one.
// 4. A public path (`policy.isPublic`) is admitted with no token.
// 5. Otherwise a credential is required: missing, unknown, or revoked is
//    401. A cookie on a checked method without an `Origin` is 403, since a
//    cookie is ambient and only the Origin shows who sent it. A live token
//    whose scope the policy does not accept is 403, not 401: the client is
//    known, and a browser holding it must not be looped back to connect.
//
// `path` is the raw request-target with the query stripped, deliberately
// not URL-normalized: a public-path predicate must match exactly what the
// router will route, never a normalized spelling of it.

import { isIPv6 } from "node:net";
import type { ClientTokenScope } from "@breakdown/db";

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
  /** `forwardedAddressesFrom(headers)`: undefined when no forwarding header is present. */
  forwardedFor: readonly string[] | undefined;
}

export interface AdmissionPolicy {
  port: number;
  /** Each already passed through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
  /** `unsafe-methods` for the web API, `all-methods` for MCP. */
  originCheck: "unsafe-methods" | "all-methods";
  /** `method` arrives upper-cased. */
  isPublic?: (method: string, path: string) => boolean;
  /** The scopes this server accepts; a live token of any other scope is 403. */
  scopes: readonly ClientTokenScope[];
  /** The client and scope of a live token, or null. */
  verifyToken: (token: string) => Promise<{ client: string; scope: ClientTokenScope } | null>;
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

  const forwardedLocal = req.forwardedFor === undefined || req.forwardedFor.every(isLoopbackAddress);
  if (req.peerIsLoopback && LOOPBACK_NAMES.has(hostName) && forwardedLocal) return { outcome: "allow", client: null };
  if (policy.isPublic?.(method, req.path)) return { outcome: "allow", client: null };

  if (req.credential === undefined) return UNAUTHORIZED;
  if (req.credential.source === "cookie" && originChecked && req.origin === undefined) return FORBIDDEN;
  const verified = await policy.verifyToken(req.credential.token);
  if (verified === null) return UNAUTHORIZED;
  if (!policy.scopes.includes(verified.scope)) return FORBIDDEN;
  return { outcome: "allow", client: verified.client };
}

/**
 * Splits a Host header into its name (lowercased; a bracketed IPv6 address
 * canonicalized as `normalizeAllowedHost` spells it) and its port text
 * (`""` when there is none), or undefined for anything malformed.
 */
function splitHost(host: string): { name: string; port: string } | undefined {
  const lowered = host.toLowerCase();
  let name: string;
  let rest: string;
  if (lowered.startsWith("[")) {
    const close = lowered.indexOf("]");
    if (close === -1 || !isIPv6(lowered.slice(1, close))) return undefined;
    try {
      name = new URL(`http://${lowered.slice(0, close + 1)}`).hostname;
    } catch {
      return undefined; // e.g. a zone id, which isIPv6 accepts and a URL does not
    }
    rest = lowered.slice(close + 1);
  } else {
    const colon = lowered.indexOf(":");
    name = colon === -1 ? lowered : lowered.slice(0, colon);
    rest = colon === -1 ? "" : lowered.slice(colon);
  }
  if (rest === "") return { name, port: "" };
  if (!/^:\d+$/.test(rest)) return undefined;
  return { name, port: rest.slice(1) };
}

/** The loopback or allowed name the Host header carries at an authority step 1 accepts, or undefined. */
function matchHost(host: string | undefined, policy: AdmissionPolicy): string | undefined {
  if (host === undefined) return undefined;
  const split = splitHost(host);
  if (split === undefined) return undefined;
  const { name, port } = split;
  if (port === String(policy.port)) return LOOPBACK_NAMES.has(name) || policy.allowedHosts.includes(name) ? name : undefined;
  // Bare: only an allowed, non-loopback name (a fronting proxy's request).
  if (port === "") return !LOOPBACK_NAMES.has(name) && policy.allowedHosts.includes(name) ? name : undefined;
  return undefined;
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
  if (LOOPBACK_NAMES.has(url.hostname)) return true;
  // `url.port` is "" when the Origin names the scheme's default port, written or not.
  return policy.allowedHosts.includes(url.hostname) && (url.port === "" || url.port === String(policy.port));
}

/**
 * Every client address a forwarding header names — each `X-Forwarded-For`
 * entry, `X-Real-IP`, and each `Forwarded` element's `for=` — with quotes,
 * brackets, and ports stripped; or undefined when none of those headers is
 * present. A value that is not an address (`unknown`, an obfuscated
 * `_name`, an element with no `for=`, an empty entry) stays in the list as
 * written, so `isLoopbackAddress` refuses it: an unreadable forwarding
 * header fails closed.
 */
export function forwardedAddressesFrom(headers: {
  "x-forwarded-for"?: string | string[];
  "x-real-ip"?: string | string[];
  forwarded?: string | string[];
}): string[] | undefined {
  const values = (header: string | string[] | undefined): string[] => (header === undefined ? [] : [header].flat());
  const xff = values(headers["x-forwarded-for"]);
  const realIp = values(headers["x-real-ip"]);
  const forwarded = values(headers.forwarded);
  if (xff.length === 0 && realIp.length === 0 && forwarded.length === 0) return undefined;

  const addresses: string[] = [];
  for (const header of xff) for (const entry of header.split(",")) addresses.push(stripAddress(entry));
  for (const header of realIp) addresses.push(stripAddress(header));
  for (const header of forwarded) {
    for (const element of header.split(",")) {
      const pair = element
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.toLowerCase().startsWith("for="));
      addresses.push(pair === undefined ? "" : stripAddress(pair.slice("for=".length)));
    }
  }
  return addresses;
}

/** `"[::1]:80"` → `::1`, `127.0.0.1:5000` → `127.0.0.1`, a bare address unchanged. */
function stripAddress(value: string): string {
  let address = value.trim();
  if (address.length >= 2 && address.startsWith('"') && address.endsWith('"')) address = address.slice(1, -1).trim();
  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    return close === -1 ? address : address.slice(1, close);
  }
  // One colon is IPv4 with a port; more is a bare IPv6 address.
  const colon = address.indexOf(":");
  return colon !== -1 && colon === address.lastIndexOf(":") ? address.slice(0, colon) : address;
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
