// The laptop relay's HTTP client for Breakdown's `/relay/v1/` API
// (docs/relay.md; laptop-relay design.md decisions 7 and 9).
//
// One request per `send`: a Bearer token, a JSON body, and a timeout. `get`
// is the same request for a binary body (a decision's image, docs/relay.md
// `GET /relay/v1/actions/:id/media/:n`): the same token, timeout, redirect,
// and error handling, resolving with the bytes and their content type. The
// token is read from the relay's own token file (bin/relay-lib.mjs checks
// its mode and shape) on first use and again after every 401, so a token
// rotated in the file is picked up without a restart; a 401 is otherwise
// an ordinary retryable failure, and the loops in main.ts back off on it
// (at most 60 s apart) like any other.
//
// What a failure says is the request's method and path, the HTTP status,
// and the server's error code and message: never the token, a header, or
// a body, because a body carries a person's review message or a herdr
// prompt. `RelayRequestError.retryable` tells a loop whether trying the
// same request again can help: a network failure, a timeout, a 401, a
// 429, or a 5xx can; any other 4xx (the request itself is wrong, or the
// action is no longer ours) cannot.
//
// A redirect is never followed (`redirect: "error"`): the Bearer token
// goes only to the origin the relay was given. The server's error code and
// message are untrusted text, so control and bidirectional characters are
// stripped and the message cut short before they reach a log line.

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_BACKOFF_MS = 60_000;
export const BASE_BACKOFF_MS = 1_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class RelayRequestError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null when no response arrived. */
    readonly status: number | null,
    /** The server's error code (`not_claimer`, …), or a local one (`network`, `timeout`, `token_file`). */
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RelayRequestError";
  }
}

export interface RelayClientOptions {
  /** The web server's origin, `https://host[:port]`, already validated. */
  origin: string;
  /** Reads and checks the token file; throws an Error whose message names the file and what is wrong (never the token). */
  readToken: () => string | Promise<string>;
  fetch?: FetchLike;
}

export interface SendOptions {
  timeoutMs?: number;
  /** Aborts the request (the relay's shutdown). */
  signal?: AbortSignal;
}

export interface RelayClient {
  readonly origin: string;
  /** One request; resolves with the parsed JSON body of a 2xx, or throws RelayRequestError. `body` is sent as JSON, or as given when already a string. */
  send(method: "GET" | "POST", path: string, body?: unknown, options?: SendOptions): Promise<unknown>;
  /** One GET of a binary body; resolves with the bytes of a 2xx and its content type, or throws RelayRequestError like `send`. */
  get(path: string, options?: SendOptions): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

const MAX_SERVER_MESSAGE_CHARS = 500;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CODE_RE = /^[a-z0-9_]{1,64}$/;

/** Server-supplied text made safe for one log line (module header). */
export function logSafe(text: string, max = MAX_SERVER_MESSAGE_CHARS): string {
  const kept = text.replace(UNSAFE_CHARS, " ").replace(/ {2,}/g, " ").trim();
  return kept.length > max ? `${kept.slice(0, max)}…` : kept;
}

function retryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

/** The server's `{ error: { code, message } }`, or a stand-in when the body is not that. */
function serverError(text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof parsed.error?.code === "string" && CODE_RE.test(parsed.error.code) ? parsed.error.code : "unknown";
    const message = typeof parsed.error?.message === "string" ? logSafe(parsed.error.message) : "";
    return { code, message };
  } catch {
    return { code: "unknown", message: "" };
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let token: string | null = null;

  async function currentToken(): Promise<string> {
    if (token !== null) return token;
    try {
      token = await options.readToken();
    } catch (err) {
      throw new RelayRequestError(err instanceof Error ? err.message : String(err), null, "token_file", true);
    }
    return token;
  }

  /** One request; the 2xx response and its body as bytes, or a RelayRequestError (module header). */
  async function request(method: "GET" | "POST", path: string, body: unknown, accept: string, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal }: SendOptions): Promise<{ res: Response; bytes: Uint8Array }> {
    const what = `${method} ${path}`;
    const bearer = await currentToken();
    if (signal?.aborted) throw new RelayRequestError(`${what}: stopped`, null, "aborted", false);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await fetchFn(`${options.origin}${path}`, {
        method,
        headers,
        redirect: "error",
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        signal: combined,
      });
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw new RelayRequestError(`${what}: stopped`, null, "aborted", false);
      if (timeout.aborted) throw new RelayRequestError(`${what}: no answer within ${Math.round(timeoutMs / 1000)} s`, null, "timeout", true);
      const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
      const why = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" && cause.message !== "" ? cause.message : err instanceof Error ? err.name : "error";
      throw new RelayRequestError(`${what}: could not reach ${options.origin} (${why})`, null, "network", true);
    }
    if (res.status === 401) token = null;
    if (res.status < 200 || res.status > 299) {
      const { code, message } = serverError(new TextDecoder().decode(bytes));
      const said = message === "" ? "" : `: ${message}`;
      throw new RelayRequestError(`${what} answered ${res.status} ${code}${said}`, res.status, code, retryableStatus(res.status));
    }
    return { res, bytes };
  }

  return {
    origin: options.origin,
    async send(method, path, body, sendOptions = {}) {
      const { res, bytes } = await request(method, path, body, "application/json", sendOptions);
      const text = new TextDecoder().decode(bytes);
      const what = `${method} ${path}`;
      try {
        return text === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        throw new RelayRequestError(`${what} answered ${res.status} with a body that is not JSON`, res.status, "invalid_response", true);
      }
    },
    async get(path, sendOptions = {}) {
      const { res, bytes } = await request("GET", path, undefined, "*/*", sendOptions);
      return { bytes, contentType: res.headers.get("content-type") };
    },
  };
}

/** Exponential backoff from BASE_BACKOFF_MS up to `maxMs`, with jitter (half to all of the step). */
export function createBackoff({ baseMs = BASE_BACKOFF_MS, maxMs = MAX_BACKOFF_MS, random = Math.random }: { baseMs?: number; maxMs?: number; random?: () => number } = {}) {
  let failures = 0;
  return {
    next(): number {
      const step = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 30));
      failures += 1;
      return Math.round(step * (0.5 + random() / 2));
    },
    reset(): void {
      failures = 0;
    },
  };
}

/** Resolves after `ms`, or at once when `signal` aborts; never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
