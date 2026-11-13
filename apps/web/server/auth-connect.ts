// `POST /auth/connect` (tailnet-hosting decision 5): trades a client token
// for the cookie that admits a browser's later requests, so a token is
// typed once into the connect screen and never travels in a URL.
//
// The dispatcher routes the exact path here after admission, which treats
// `POST /auth/connect` as public: it still passes the Host check and, being
// a POST, the Origin check, but needs no credential — it is where one is
// obtained. Every other method on the path needs one like any other path,
// so a tailnet GET is 401 before it gets here; a loopback one gets 405.
//
// The cookie holds the token itself, so revoking the token ends every
// cookie carrying it with no session table. It is HttpOnly (no script
// reads it) and SameSite=Strict, and `Secure` only when the request came in
// over HTTPS: the socket is TLS, or a loopback peer (a local proxy such as
// `tailscale serve`) says `x-forwarded-proto: https`. A non-loopback peer's
// forwarding header is ignored. Plain HTTP over WireGuard is the expected
// path, where `Secure` would make the browser drop the cookie.
//
// Nothing here logs or echoes the token; every response body is a fixed
// string.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackAddress, TOKEN_COOKIE_NAME, UNAUTHORIZED_HEADERS } from "@breakdown/core";

export const AUTH_CONNECT_PATH = "/auth/connect";
/** A token is 47 characters; a JSON body carrying one is far below this. */
export const MAX_CONNECT_BODY_BYTES = 4 * 1024;
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** RFC 6265 cookie-octet: what may sit unquoted in a cookie value. A real token (base64url) always matches. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

export interface ConnectHandlerOptions {
  /** The client a live token belongs to, or null. A throw propagates to the dispatcher (500). */
  verifyToken: (token: string) => Promise<string | null>;
}

function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

/** The whole body, or undefined once it passes `limit` bytes. */
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

/** 413, discarding the rest of the body and closing the connection rather than reading it. */
function sendTooLarge(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  sendText(res, 413, "Payload Too Large\n", { Connection: "close" });
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** True when the request reached us over HTTPS (module header). */
function arrivedOverHttps(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = req.headers["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.trim().toLowerCase() === "https";
}

export function tokenCookie(token: string, secure: boolean): string {
  return `${TOKEN_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function createConnectHandler({ verifyToken }: ConnectHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed\n", { Allow: "POST" });
      return;
    }
    if (!isJsonContentType(req.headers["content-type"])) {
      sendText(res, 415, "Unsupported Media Type: send application/json\n");
      return;
    }
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > MAX_CONNECT_BODY_BYTES) {
      sendTooLarge(req, res);
      return;
    }
    const body = await readBody(req, MAX_CONNECT_BODY_BYTES);
    if (body === undefined) {
      sendTooLarge(req, res);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      sendText(res, 400, "Bad Request: the body must be JSON {\"token\": \"...\"}\n");
      return;
    }
    const token = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { token?: unknown }).token : undefined;
    if (typeof token !== "string" || token === "") {
      sendText(res, 400, "Bad Request: the body must be JSON {\"token\": \"...\"}\n");
      return;
    }

    // A value that cannot sit in a cookie is no token we issued; refusing it
    // here also keeps it out of the Set-Cookie header.
    const client = COOKIE_VALUE.test(token) ? await verifyToken(token) : null;
    if (client === null) {
      sendText(res, 401, "Unauthorized\n", { ...UNAUTHORIZED_HEADERS });
      return;
    }
    res.writeHead(204, { "Set-Cookie": tokenCookie(token, arrivedOverHttps(req)), "Cache-Control": "no-store" });
    res.end();
  };
}
