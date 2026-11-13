// The review image route (board-visual-reviews, design.md decision 4):
// `GET /review-images/<relative path>` serves one screenshot or video from the
// review image root (core's REVIEW_IMAGE_ROOT, `~/.local/share/breakdown/reviews`)
// and nothing else (video-review-attachments added mp4/webm and byte ranges). index.ts dispatches the prefix here before the tRPC
// handler on the same loopback server; Vite proxies it in development.
//
// A request is checked in this order, and each refusal happens before any
// later step runs:
//   1. decode each path segment (a malformed escape or a NUL → 400);
//   2. lexical containment under the root (`..` in any spelling → 403,
//      without touching the filesystem);
//   3. the requested name ends in png/jpg/jpeg/gif/webp/mp4/webm (else
//      403; `.mov` included, since browsers other than Safari can't play it);
//   4. realpath the root and the target (missing → 404);
//   5. the real target is inside the real root (a symlink that leads out
//      → 403);
//   6. the real target's own name is an image or video (a `.png` symlink to
//      a text file → 403);
//   7. it is a regular file (a directory → 404).
// Only then is it opened and streamed, with its type, `Cache-Control:
// no-store`, `X-Content-Type-Options: nosniff`, and `Accept-Ranges: bytes`.
//
// Byte ranges (video-review-attachments, design.md decision 4): Safari will
// not play a video whose server ignores `Range`, and seeking in any browser
// needs it. One range is honored (`parseByteRange`): a satisfiable one is a
// 206 with `Content-Range` and exactly those bytes; an unsatisfiable one is a
// 416 with `Content-Range: bytes */<size>`; a malformed, reversed, or
// multi-range header is ignored and the whole file served, which RFC 9110
// permits. HEAD answers the same status and headers with no body.
//
// Accepted race: between the realpath in step 5 and the open, a file inside
// the root could be swapped for a symlink that leads out. Closing that needs
// O_NOFOLLOW on every path component; for a loopback-only, single-user tool
// whose root only the user's own CLI writes, the check-then-open is enough.
//
// `reviewImageUrl` is the other direction, used by the board item DTO: an
// absolute image path under the root becomes the URL this route serves it
// at, each segment percent-encoded; anything outside the root is null, so
// the drawer shows it as missing without making a request.

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isInsideReviewRoot, REVIEW_IMAGE_ROOT } from "@breakdown/core";

export const REVIEW_IMAGES_PREFIX = "/review-images/";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const SERVED_NAME = /\.(png|jpe?g|gif|webp|mp4|webm)$/i;
const NOT_SERVED = "Not a review image or video";

export type ByteRange = { start: number; end: number };

/**
 * The single byte range a `Range` header asks of a `size`-byte file
 * (module header): `{start, end}` inclusive, "unsatisfiable" for a range
 * that starts past the end, a zero-length suffix, or any range of an empty
 * file, and null for a header to ignore (absent, malformed, reversed, or
 * several ranges).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match as unknown as [string, string, string];
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (size === 0 || start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { start, end };
}

/** The URL `createReviewImageHandler` serves `absolutePath` at, or null when it is not inside `root`. */
export function reviewImageUrl(absolutePath: string, root: string = REVIEW_IMAGE_ROOT): string | null {
  if (!isInsideReviewRoot(absolutePath, root)) return null;
  const rel = path.relative(root, path.resolve(absolutePath));
  return REVIEW_IMAGES_PREFIX + rel.split(path.sep).map(encodeURIComponent).join("/");
}

export type ResolvedReviewImage =
  | { ok: true; file: string; contentType: string; size: number }
  | { ok: false; status: 400 | 403 | 404; reason: string };

/**
 * The file a request path names, after every check in the module header,
 * or the status to refuse it with. `pathname` is the URL path (no query),
 * starting with REVIEW_IMAGES_PREFIX.
 */
export async function resolveReviewImage(pathname: string, root: string = REVIEW_IMAGE_ROOT): Promise<ResolvedReviewImage> {
  if (!pathname.startsWith(REVIEW_IMAGES_PREFIX)) return { ok: false, status: 404, reason: "Not found" };
  const segments: string[] = [];
  for (const raw of pathname.slice(REVIEW_IMAGES_PREFIX.length).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { ok: false, status: 400, reason: "Malformed path" };
    }
    if (segment.includes("\u0000")) return { ok: false, status: 400, reason: "Malformed path" };
    segments.push(segment);
  }
  const requested = path.resolve(root, ...segments);
  if (!isInsideReviewRoot(requested, root)) return { ok: false, status: 403, reason: "Outside the review image root" };
  if (!SERVED_NAME.test(requested)) return { ok: false, status: 403, reason: NOT_SERVED };

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(requested);
  } catch (err) {
    const refusal = fsRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  if (!isInsideReviewRoot(realTarget, realRoot)) return { ok: false, status: 403, reason: "Outside the review image root" };
  const ext = path.extname(realTarget).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (contentType === undefined) return { ok: false, status: 403, reason: NOT_SERVED };
  let info;
  try {
    info = await stat(realTarget);
  } catch (err) {
    const refusal = fsRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
  if (!info.isFile()) return { ok: false, status: 404, reason: "Not found" };
  return { ok: true, file: realTarget, contentType, size: info.size };
}

/** A filesystem error that is the request's fault, as the status to refuse it with; anything else is the server's. */
function fsRefusal(err: unknown): ResolvedReviewImage | null {
  switch ((err as NodeJS.ErrnoException).code) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
      return { ok: false, status: 404, reason: "Not found" };
    case "ENAMETOOLONG":
      return { ok: false, status: 400, reason: "Malformed path" };
    default:
      return null;
  }
}

/** Stream errors that mean the client stopped reading, not that serving failed. */
const CLIENT_GONE: ReadonlySet<string> = new Set(["ERR_STREAM_PREMATURE_CLOSE", "EPIPE", "ECONNRESET"]);

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

function refuse(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...COMMON_HEADERS, ...extraHeaders });
  res.end(`${text}\n`);
}

export interface ReviewImageHandlerOptions {
  root?: string;
}

/** The Node request handler for REVIEW_IMAGES_PREFIX (module header). */
export function createReviewImageHandler(options: ReviewImageHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = options.root ?? REVIEW_IMAGE_ROOT;
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      refuse(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    // The raw path, query dropped. Not `new URL(...).pathname`: that would
    // resolve `..` and `%2e%2e` segments away before the containment check
    // could see (and refuse) them.
    const pathname = (req.url ?? "/").split("?", 1)[0]!;
    let resolved: ResolvedReviewImage;
    try {
      resolved = await resolveReviewImage(pathname, root);
    } catch (err) {
      console.error("[breakdown-web] review image lookup failed:", err);
      refuse(res, 500, "Internal error");
      return;
    }
    if (!resolved.ok) {
      refuse(res, resolved.status, resolved.reason);
      return;
    }
    const range = parseByteRange(req.headers.range, resolved.size);
    if (range === "unsatisfiable") {
      refuse(res, 416, "Range not satisfiable", { "Accept-Ranges": "bytes", "Content-Range": `bytes */${resolved.size}` });
      return;
    }
    if (range === null) {
      res.writeHead(200, {
        "Content-Type": resolved.contentType,
        "Content-Length": String(resolved.size),
        "Accept-Ranges": "bytes",
        ...COMMON_HEADERS,
      });
    } else {
      res.writeHead(206, {
        "Content-Type": resolved.contentType,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${resolved.size}`,
        "Accept-Ranges": "bytes",
        ...COMMON_HEADERS,
      });
    }
    if (req.method === "HEAD" || resolved.size === 0) {
      res.end();
      return;
    }
    try {
      // Bounded by the size just sent as Content-Length, so a file that grows mid-stream never overruns it.
      await pipeline(createReadStream(resolved.file, range ?? { start: 0, end: resolved.size - 1 }), res);
    } catch (err) {
      // A client that went away mid-file (a closed lightbox, a navigation) is not an error worth logging.
      // (pipeline has destroyed `res` by now either way, so the code is what tells them apart.)
      if (!CLIENT_GONE.has((err as NodeJS.ErrnoException).code ?? "")) {
        console.error("[breakdown-web] review image stream failed:", err);
      }
      res.destroy();
    }
  };
}
