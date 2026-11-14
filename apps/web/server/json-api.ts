// Request plumbing shared by the web server's JSON REST APIs: hangar's
// (`/hangar/v1`, hangar-api.ts) and the laptop relay's (`/relay/v1`,
// relay-api.ts; laptop-relay decision 9). It was hangar's own, moved here
// unchanged except that the body cap is a parameter, so both APIs answer
// one error shape and one long-poll discipline.
//
// Every error is `{ "error": { "code", "message" } }` with the status the
// `ApiError` carries. A JSON body needs `application/json`, at most the
// caller's byte cap (declared or streamed; past it, 413 and the connection
// is closed), strict UTF-8, and a body the schema accepts. A long-poll
// re-runs its attempt once a second until it finds something, its bound
// passes, or its signal aborts; nothing is held across a pause. The waiter
// cap bounds the long-polls one client holds open at once.
//
// Nothing here logs a token, a header, a query string, or a body.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

/** How often a long-poll re-runs its query. */
const POLL_INTERVAL_MS = 1000;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** A refusal an API answers with its own status and error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const invalidRequest = (message: string): ApiError => new ApiError(400, "invalid_request", message);

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // A long-poll whose client left has nobody to answer.
  if (res.destroyed) return;
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, err: ApiError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
}

/** The raw request-target split at its query, never URL-normalized. */
export function splitUrl(rawUrl: string | undefined): { path: string; query: URLSearchParams } {
  const url = rawUrl ?? "/";
  const queryAt = url.indexOf("?");
  return {
    path: queryAt === -1 ? url : url.slice(0, queryAt),
    query: new URLSearchParams(queryAt === -1 ? "" : url.slice(queryAt + 1)),
  };
}

// --- Request bodies ----------------------------------------------------------------

/** The whole body, or undefined once it passes `limit` bytes (auth-connect.ts's shape). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const tooLarge = (maxBytes: number): ApiError => new ApiError(413, "too_large", `The body must be at most ${maxBytes} bytes.`, { Connection: "close" });

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(";")[0]!.trim().toLowerCase() === "application/json";
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "(body)" : issue.path.join(".")}: ${issue.message}`).join("; ");
}

/** The body parsed against `schema`, or a 415, 413 (past `maxBytes`), 400 invalid_json, or 400 invalid_request. */
export async function readJsonBody<T extends z.ZodType>(req: IncomingMessage, schema: T, maxBytes: number): Promise<z.infer<T>> {
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new ApiError(415, "unsupported_media_type", "Send the body as Content-Type: application/json.");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) {
    req.resume();
    throw tooLarge(maxBytes);
  }
  const raw = await readBody(req, maxBytes);
  if (raw === undefined) {
    req.resume();
    throw tooLarge(maxBytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ApiError(400, "invalid_json", "The body is not valid UTF-8 JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw invalidRequest(formatIssues(result.error));
  return result.data;
}

// --- Routing -------------------------------------------------------------------------

/** The path's `:id`, or null when `path` does not fit `pattern` segment by segment. */
export function matchPath(pattern: string, path: string): { id: string | undefined } | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  let id: string | undefined;
  for (let i = 0; i < want.length; i += 1) {
    if (want[i] === ":id") id = got[i];
    else if (want[i] !== got[i]) return null;
  }
  return { id };
}

// --- Long-poll ------------------------------------------------------------------------

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs `attempt` until it returns something, `waitS` seconds pass, or
 * `signal` aborts (module header); null when nothing turned up. An aborted
 * signal stops it before the next attempt, never after.
 */
export async function longPoll<T>(waitS: number, signal: AbortSignal, attempt: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    if (signal.aborted) return null;
    const found = await attempt();
    if (found !== null) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await pause(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
}

/** Runs one long-poll of `waitS` seconds for `client` under the cap; `waitS` 0 is not a long-poll and is never refused. */
export type WaiterCap = <T>(client: string, waitS: number, run: () => Promise<T>) => Promise<T>;

/**
 * A per-client cap of `max` open long-polls. Past it a long-poll is refused
 * with 429 `too_many_waiters`, `Retry-After: 1`, and `message`.
 */
export function createWaiterCap(max: number, message: string): WaiterCap {
  const waiting = new Map<string, number>();
  return async (client, waitS, run) => {
    if (waitS === 0) return run();
    const held = waiting.get(client) ?? 0;
    if (held >= max) {
      throw new ApiError(429, "too_many_waiters", message, { "Retry-After": "1" });
    }
    waiting.set(client, held + 1);
    try {
      return await run();
    } finally {
      const left = (waiting.get(client) ?? 1) - 1;
      if (left <= 0) waiting.delete(client);
      else waiting.set(client, left);
    }
  };
}
