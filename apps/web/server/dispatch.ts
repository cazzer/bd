// The API server's one request listener (index.ts). Every request is first
// given a route by `routeFor`, then passes the shared admission function
// (packages/core admission.ts; tailnet-hosting decision 2) under that
// route's policy: a foreign Host, or an unsafe method from a foreign
// Origin, is 403; a request that needs a client token and lacks a live one
// is 401 with `WWW-Authenticate: Bearer`. A loopback peer with a loopback
// Host needs no token, as before, unless a forwarding header names a remote
// address. Then it is dispatched on the same route value, so the policy
// that admitted a request is always the one for the handler it reaches.
//
// One classifier, `routeFor`, names where a path goes, and the routing,
// the per-route policy, and the public-path rule all read it, so they
// cannot disagree. On the raw path (query dropped, never URL-normalized):
//   exactly AUTH_CONNECT_PATH          → the connect handler (auth-connect.ts)
//   exactly HEALTH_PATH                → the health handler (health.ts)
//   under REVIEW_IMAGES_PREFIX         → the review image route (review-images.ts)
//   under HANGAR_API_PREFIX            → hangar's REST API (hangar-api.ts)
//   `/trpc` or under `/trpc/`          → tRPC's standalone handler
//   anything else                      → the built client (static-client.ts)
//                                        when one is configured, else tRPC
// What needs no token: `POST /auth/connect`, and GET/HEAD of a path routed
// to the built client (it holds no data; client-access spec). Because the
// client is an exact manifest lookup, a path that only resolves to a data
// route after normalization (`/x/../trpc/a`, `/%74rpc/a`) is classified as
// client and can only get index.html or a 404; the hangar API is classified
// ahead of the client, so its paths never fall to the client's index
// fallback, and a spelling of them that only normalizes to the prefix is
// the client's too. `/healthz` is not public.
//
// Admission scopes are per route (hangar-queue decision 1): connect, the
// review images, and the built client take only `human` tokens; the health
// check takes any scope; tRPC takes `human` and `agent`, and each procedure
// narrows that further (trpc.ts `scopeGate`, decision 5) — an agent files
// and completes inbox requests, a person decides. The hangar API takes
// `hangar` and `agent` tokens, and each endpoint narrows that further
// (hangar-api.ts): the hangar token reaches the service endpoints, a
// worker's session token only its messages. On that route the
// dispatcher's own 401 and 403 use the API's JSON error body, so a client
// built against docs/hangar-api.md parses one shape.
//
// The admitted token client, scope, and bound session are handed to tRPC through
// `admittedClients` (context.ts), keyed on the request object, so a write's
// run names the client that made it (tailnet-hosting decision 4) and a
// procedure can check the scope. Nothing here logs a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  admitRequest,
  credentialFrom,
  forwardedAddressesFrom,
  isLoopbackAddress,
  UNAUTHORIZED_HEADERS,
  type AdmissionPolicy,
  type ClientTokenScope,
  type VerifiedClientToken,
} from "@breakdown/core";
import { AUTH_CONNECT_PATH } from "./auth-connect.js";
import { admittedClients, type AdmittedClient } from "./context.js";
import { HANGAR_API_PREFIX } from "./hangar-api.js";
import { REVIEW_IMAGES_PREFIX } from "./review-images.js";

export const HEALTH_PATH = "/healthz";
const TRPC_PATH = "/trpc";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface RequestDispatcherOptions {
  /** The port the server listens on; admission pins Host to it. */
  port: number;
  /** `--allow-host` values, each already through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
  /** The client, scope, and bound session of a live token, or null (verifyClientToken in production). */
  verifyToken: (token: string) => Promise<VerifiedClientToken | null>;
  connect: Handler;
  health: Handler;
  reviewImages: Handler;
  /** The hangar REST API (hangar-api.ts), handed what admission established; null for a tokenless request. */
  hangar: (req: IncomingMessage, res: ServerResponse, admitted: AdmittedClient | null) => Promise<void>;
  trpc: (req: IncomingMessage, res: ServerResponse) => void;
  /** The built client (static-client.ts), when `--client-dir` is given; without it every unclassified path goes to tRPC as before. */
  staticClient?: Handler;
}

export type WebRoute = "connect" | "health" | "reviewImages" | "hangar" | "trpc" | "static";

/**
 * Where a raw request path goes (module header), decided before admission
 * so the route's own policy admits it. `path` is the raw request-target
 * with the query stripped, never URL-normalized (admission.ts header): a
 * different spelling of the connect path is not the connect path. `static`
 * only when a client handler is configured.
 */
export function routeFor(path: string, hasStaticClient: boolean): WebRoute {
  if (path === AUTH_CONNECT_PATH) return "connect";
  if (path === HEALTH_PATH) return "health";
  if (path.startsWith(REVIEW_IMAGES_PREFIX)) return "reviewImages";
  if (path.startsWith(HANGAR_API_PREFIX)) return "hangar";
  if (path === TRPC_PATH || path.startsWith(`${TRPC_PATH}/`)) return "trpc";
  return hasStaticClient ? "static" : "trpc";
}

/**
 * What admission lets through without a token. The one place the web's
 * public surface is named: the connect endpoint, where a token is
 * obtained, and reads of the built client.
 */
function isPublicRoute(method: string, route: WebRoute): boolean {
  if (method === "POST" && route === "connect") return true;
  return (method === "GET" || method === "HEAD") && route === "static";
}

const PLAIN_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** An admission refusal: plain text everywhere but the hangar API, which gets its JSON error body (docs/hangar-api.md). */
function refuse(res: ServerResponse, route: WebRoute, status: 401 | 403, byCredential = false): void {
  const extra = status === 401 ? UNAUTHORIZED_HEADERS : {};
  if (route === "hangar") {
    const error =
      status === 401
        ? { code: "unauthorized", message: "A live token is required: send Authorization: Bearer <token>." }
        : { code: "forbidden", message: byCredential ? "This token's scope cannot use the hangar API." : "Refused: this Host or Origin is not allowed." };
    res.writeHead(status, { ...JSON_HEADERS, ...extra });
    res.end(JSON.stringify({ error }));
    return;
  }
  res.writeHead(status, { ...PLAIN_HEADERS, ...extra });
  res.end(status === 401 ? "Unauthorized\n" : "Forbidden\n");
}

export function createRequestDispatcher({ port, allowedHosts, verifyToken, connect, health, reviewImages, hangar, trpc, staticClient }: RequestDispatcherOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const hasStaticClient = staticClient !== undefined;
  const isPublic = (method: string, path: string) => isPublicRoute(method, routeFor(path, hasStaticClient));
  const policyFor = (scopes: readonly ClientTokenScope[]): AdmissionPolicy => ({ port, allowedHosts, originCheck: "unsafe-methods", scopes, isPublic, verifyToken });
  // The token scopes each route admits (module header).
  const policies: Readonly<Record<WebRoute, AdmissionPolicy>> = {
    connect: policyFor(["human"]),
    health: policyFor(["human", "agent", "hangar"]),
    reviewImages: policyFor(["human"]),
    hangar: policyFor(["hangar", "agent"]),
    trpc: policyFor(["human", "agent"]),
    static: policyFor(["human"]),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The raw request-target, deliberately not URL-normalized (admission.ts header).
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const route = routeFor(path, hasStaticClient);
    const admission = await admitRequest(
      {
        method: req.method,
        host: req.headers.host,
        origin: req.headers.origin,
        peerIsLoopback: isLoopbackAddress(req.socket.remoteAddress),
        path,
        credential: credentialFrom(req.headers),
        forwardedFor: forwardedAddressesFrom(req.headers),
      },
      policies[route],
    );
    if (admission.outcome === "forbidden") {
      refuse(res, route, 403, admission.byCredential);
      return;
    }
    if (admission.outcome === "unauthorized") {
      refuse(res, route, 401);
      return;
    }
    let admitted: AdmittedClient | null = null;
    if (admission.client !== null && admission.scope !== null) {
      admitted = { client: admission.client, scope: admission.scope, sessionId: admission.sessionId };
      admittedClients.set(req, admitted);
    }

    switch (route) {
      case "connect":
        await connect(req, res);
        return;
      case "health":
        await health(req, res);
        return;
      case "reviewImages":
        await reviewImages(req, res);
        return;
      case "hangar":
        await hangar(req, res, admitted);
        return;
      case "static":
        await staticClient!(req, res);
        return;
      case "trpc":
        trpc(req, res);
        return;
    }
  }

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      // The method and the path only: a query string is never logged, nor any header.
      const rawUrl = req.url ?? "/";
      const queryAt = rawUrl.indexOf("?");
      console.error(`[breakdown-web] ${req.method} ${queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)} failed:`, err);
      if (!res.headersSent) {
        res.writeHead(500, PLAIN_HEADERS);
        res.end("Internal Server Error\n");
      } else {
        res.destroy();
      }
    });
  };
}
