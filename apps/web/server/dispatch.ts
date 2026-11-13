// The API server's one request listener (index.ts). Every request first
// passes the shared admission function (packages/core admission.ts;
// tailnet-hosting decision 2): a foreign Host, or an unsafe method from a
// foreign Origin, is 403; a request that needs a client token and lacks a
// live one is 401 with `WWW-Authenticate: Bearer`. A loopback peer with a
// loopback Host needs no token, as before. Then, in order: the exact path
// AUTH_CONNECT_PATH to the connect handler (auth-connect.ts), anything
// under REVIEW_IMAGES_PREFIX to the review image route (review-images.ts),
// and everything else to tRPC's standalone handler.
//
// The admitted token client is handed to tRPC through `admittedClients`
// (context.ts), keyed on the request object, so a write's run names the
// client that made it (decision 4). Nothing here logs a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import { admitRequest, credentialFrom, isLoopbackAddress, UNAUTHORIZED_HEADERS, type AdmissionPolicy } from "@breakdown/core";
import { AUTH_CONNECT_PATH } from "./auth-connect.js";
import { admittedClients } from "./context.js";
import { REVIEW_IMAGES_PREFIX } from "./review-images.js";

export interface RequestDispatcherOptions {
  /** The port the server listens on; admission pins Host to it. */
  port: number;
  /** `--allow-host` values, each already through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
  /** The client a live token belongs to, or null (verifyClientToken in production). */
  verifyToken: (token: string) => Promise<string | null>;
  connect: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  reviewImages: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  trpc: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * What admission lets through without a token. The one place the web's
 * public surface is named: today only the connect endpoint, where a token
 * is obtained.
 */
function isPublicPath(method: string, path: string): boolean {
  return method === "POST" && path === AUTH_CONNECT_PATH;
}

const PLAIN_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export function createRequestDispatcher({ port, allowedHosts, verifyToken, connect, reviewImages, trpc }: RequestDispatcherOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const policy: AdmissionPolicy = { port, allowedHosts, originCheck: "unsafe-methods", isPublic: isPublicPath, verifyToken };

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

    if (path === AUTH_CONNECT_PATH) {
      await connect(req, res);
      return;
    }
    if (rawUrl.startsWith(REVIEW_IMAGES_PREFIX)) {
      await reviewImages(req, res);
      return;
    }
    trpc(req, res);
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
