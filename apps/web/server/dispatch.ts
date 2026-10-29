// The API server's one request listener (index.ts): the request guard
// first (request-guard.ts — a foreign Host, or a write from a foreign
// Origin, is refused before any handler runs), then the review image route
// for REVIEW_IMAGES_PREFIX (review-images.ts), then tRPC's standalone
// handler for everything else.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedRequest } from "./request-guard.js";
import { REVIEW_IMAGES_PREFIX } from "./review-images.js";

export interface RequestDispatcherOptions {
  /** The port the server listens on; the guard pins Host to it. */
  port: number;
  reviewImages: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  trpc: (req: IncomingMessage, res: ServerResponse) => void;
}

export function createRequestDispatcher({ port, reviewImages, trpc }: RequestDispatcherOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!isAllowedRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin }, port)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end("Forbidden\n");
      return;
    }
    if (req.url?.startsWith(REVIEW_IMAGES_PREFIX)) {
      reviewImages(req, res).catch((err: unknown) => {
        console.error("[breakdown-web] review image request failed:", err);
        res.destroy();
      });
      return;
    }
    trpc(req, res);
  };
}
