// The API server's one request listener (index.ts). Every request first
// passes the shared admission function (packages/core admission.ts;
// tailnet-hosting decision 2): a foreign Host, or an unsafe method from a
// foreign Origin, is 403; a request that needs a client token and lacks a
// live one is 401 with `WWW-Authenticate: Bearer`. A loopback peer with a
// loopback Host needs no token, as before, unless a forwarding header names
// a remote address. The web accepts only `human` tokens: its writes are a
// person's decisions, so an `agent` token is 403 here (decision 9).
//
// One classifier, `routeFor`, names where a path goes, and both the
// routing and the public-path rule read it, so they cannot disagree. On
// the raw path (query dropped, never URL-normalized):
//   exactly AUTH_CONNECT_PATH          → the connect handler (auth-connect.ts)
//   exactly HEALTH_PATH                → the health handler (health.ts)
//   under REVIEW_IMAGES_PREFIX         → the review image route (review-images.ts)
//   `/trpc` or under `/trpc/`          → tRPC's standalone handler
//   anything else                      → the built client (static-client.ts)
//                                        when one is configured, else tRPC
// What needs no token: `POST /auth/connect`, and GET/HEAD of a path routed
// to the built client (it holds no data; client-access spec). Because the
// client is an exact manifest lookup, a path that only resolves to a data
// route after normalization (`/x/../trpc/a`, `/%74rpc/a`) is classified as
// client and can only get index.html or a 404. `/healthz` is not public.
//
// The admitted token client is handed to tRPC through `admittedClients`
// (context.ts), keyed on the request object, so a write's run names the
// client that made it (decision 4). Nothing here logs a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  admitRequest,
  credentialFrom,
  forwardedAddressesFrom,
  isLoopbackAddress,
  UNAUTHORIZED_HEADERS,
  type AdmissionPolicy,
  type ClientTokenScope,
} from "@breakdown/core";
import { AUTH_CONNECT_PATH } from "./auth-connect.js";
import { admittedClients } from "./context.js";
import { REVIEW_IMAGES_PREFIX } from "./review-images.js";

export const HEALTH_PATH = "/healthz";
const TRPC_PATH = "/trpc";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface RequestDispatcherOptions {
  /** The port the server listens on; admission pins Host to it. */
  port: number;
  /** `--allow-host` values, each already through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
  /** The client and scope of a live token, or null (verifyClientToken in production). */
  verifyToken: (token: string) => Promise<{ client: string; scope: ClientTokenScope } | null>;
  connect: Handler;
  health: Handler;
  reviewImages: Handler;
  trpc: (req: IncomingMessage, res: ServerResponse) => void;
  /** The built client (static-client.ts), when `--client-dir` is given; without it every unclassified path goes to tRPC as before. */
  staticClient?: Handler;
}

export type Route = "connect" | "health" | "review-images" | "trpc" | "static";

/** Where a raw request path goes (module header). `static` only when a client handler is configured. */
export function routeFor(path: string, hasStaticClient: boolean): Route {
  if (path === AUTH_CONNECT_PATH) return "connect";
  if (path === HEALTH_PATH) return "health";
  if (path.startsWith(REVIEW_IMAGES_PREFIX)) return "review-images";
  if (path === TRPC_PATH || path.startsWith(`${TRPC_PATH}/`)) return "trpc";
  return hasStaticClient ? "static" : "trpc";
}

/**
 * What admission lets through without a token. The one place the web's
 * public surface is named: the connect endpoint, where a token is
 * obtained, and reads of the built client.
 */
function isPublicPath(method: string, path: string, hasStaticClient: boolean): boolean {
  if (method === "POST" && path === AUTH_CONNECT_PATH) return true;
  return (method === "GET" || method === "HEAD") && routeFor(path, hasStaticClient) === "static";
}

/** A person's tokens only (module header). */
const WEB_SCOPES: readonly ClientTokenScope[] = ["human"];

const PLAIN_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export function createRequestDispatcher({ port, allowedHosts, verifyToken, connect, health, reviewImages, trpc, staticClient }: RequestDispatcherOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const hasStaticClient = staticClient !== undefined;
  const isPublic = (method: string, path: string) => isPublicPath(method, path, hasStaticClient);
  const policy: AdmissionPolicy = { port, allowedHosts, originCheck: "unsafe-methods", scopes: WEB_SCOPES, isPublic, verifyToken };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The raw request-target, deliberately not URL-normalized (admission.ts header).
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
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
      policy,
    );
    if (admission.outcome === "forbidden") {
      res.writeHead(403, PLAIN_HEADERS);
      res.end("Forbidden\n");
      return;
    }
    if (admission.outcome === "unauthorized") {
      res.writeHead(401, { ...PLAIN_HEADERS, ...UNAUTHORIZED_HEADERS });
      res.end("Unauthorized\n");
      return;
    }
    if (admission.client !== null) admittedClients.set(req, admission.client);

    switch (routeFor(path, hasStaticClient)) {
      case "connect":
        await connect(req, res);
        return;
      case "health":
        await health(req, res);
        return;
      case "review-images":
        await reviewImages(req, res);
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
