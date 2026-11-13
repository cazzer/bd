// The built browser client, served by the web server itself when it is
// given `--client-dir` (tailnet-hosting design.md decision 6): the
// container has no Vite, so the board's HTML, scripts, and styles come from
// `vite build`'s output. Under `pnpm dev` no directory is given and Vite
// serves the client as before.
//
// The directory is read once, at startup, into a manifest keyed on URL
// path (each segment percent-encoded the way a browser sends it). The walk
// does not follow symlinks: a link in the build output is not served, so
// nothing outside the directory can be reached through it. A request is an
// exact lookup of its raw path (query dropped) in that manifest, never a
// filesystem path built from the request, so `..` in any spelling can only
// miss. That is what lets dispatch.ts make every path it routes here public
// (the client holds no data): the worst a crafted path can do is get
// index.html or a 404.
//
//   hit `/index.html`        → index.html, buffered, `Cache-Control: no-cache`
//   hit under `/assets/`     → `public, max-age=31536000, immutable` (Vite
//                              puts a content hash in every name there)
//   any other hit            → `no-cache`
//   miss, last segment has
//   no `.` (a client route)  → index.html, `no-cache`
//   miss with an extension   → 404
//   not GET or HEAD          → 405 with `Allow: GET, HEAD`
//
// Every response carries `X-Content-Type-Options: nosniff`; HEAD answers
// the same status and headers with no body.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export interface ClientFile {
  /** Absolute path on disk. */
  file: string;
  size: number;
  /** The Content-Type it is served with. */
  type: string;
  /** Served with a year-long immutable cache (under `/assets/`). */
  immutable: boolean;
  /** The file's bytes, read at load: index.html only, which answers every client route. */
  body?: Buffer;
}

export type ClientManifest = ReadonlyMap<string, ClientFile>;

const INDEX_PATH = "/index.html";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Walks `dir` (not following symlinks) into a manifest keyed on URL path.
 * Throws naming `dir` when it cannot be read or holds no index.html.
 */
export async function loadClientManifest(dir: string): Promise<Map<string, ClientFile>> {
  const root = path.resolve(dir);
  const manifest = new Map<string, ClientFile>();

  async function walk(abs: string, urlSegments: readonly string[]): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const file = path.join(abs, entry.name);
      const segments = [...urlSegments, encodeURIComponent(entry.name)];
      if (entry.isDirectory()) {
        await walk(file, segments);
      } else if (entry.isFile()) {
        const urlPath = `/${segments.join("/")}`;
        manifest.set(urlPath, { file, size: (await stat(file)).size, type: contentTypeOf(file), immutable: urlPath.startsWith("/assets/") });
      }
      // Symlinks, sockets, and the rest are left out (module header).
    }
  }

  try {
    await walk(root, []);
  } catch (err) {
    throw new Error(`client directory ${root} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const index = manifest.get(INDEX_PATH);
  if (index === undefined) throw new Error(`client directory ${root} has no index.html; build the client first (pnpm --filter @breakdown/web build)`);
  const body = await readFile(index.file);
  manifest.set(INDEX_PATH, { ...index, size: body.length, body });
  return manifest;
}

const NOSNIFF = { "X-Content-Type-Options": "nosniff" } as const;
const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Stream errors that mean the client stopped reading, not that serving failed. */
const CLIENT_GONE: ReadonlySet<string> = new Set(["ERR_STREAM_PREMATURE_CLOSE", "EPIPE", "ECONNRESET"]);

function refuse(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...NOSNIFF, ...extra });
  res.end(`${text}\n`);
}

/** The handler for every path dispatch.ts routes to the client (module header). `manifest` comes from `loadClientManifest`. */
export function createStaticClientHandler(manifest: ClientManifest): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const index = manifest.get(INDEX_PATH);
  const indexBody = index?.body;
  if (index === undefined || indexBody === undefined) throw new Error("client manifest has no buffered index.html; build it with loadClientManifest");

  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      refuse(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    const urlPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const hit = manifest.get(urlPath);
    const lastSegment = urlPath.slice(urlPath.lastIndexOf("/") + 1);

    if (hit === undefined && lastSegment.includes(".")) {
      refuse(res, 404, "Not found");
      return;
    }
    if (hit === undefined || hit === index) {
      res.writeHead(200, { "Content-Type": index.type, "Content-Length": String(indexBody.length), "Cache-Control": NO_CACHE, ...NOSNIFF });
      res.end(req.method === "HEAD" ? undefined : indexBody);
      return;
    }

    res.writeHead(200, { "Content-Type": hit.type, "Content-Length": String(hit.size), "Cache-Control": hit.immutable ? IMMUTABLE : NO_CACHE, ...NOSNIFF });
    if (req.method === "HEAD" || hit.size === 0) {
      res.end();
      return;
    }
    try {
      // Bounded by the size just sent as Content-Length.
      await pipeline(createReadStream(hit.file, { start: 0, end: hit.size - 1 }), res);
    } catch (err) {
      if (!CLIENT_GONE.has((err as NodeJS.ErrnoException).code ?? "")) {
        console.error(`[breakdown-web] client file ${urlPath} failed:`, err);
      }
      res.destroy();
    }
  };
}
