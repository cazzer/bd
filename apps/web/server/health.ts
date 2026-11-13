// `GET /healthz` on the web server (tailnet-hosting task 2.1): 200
// `{ready:true}` when the database answers `select 1` within 2 s, else 503
// `{ready:false,error}`. It writes nothing and needs a token off loopback
// like every data path (dispatch.ts): only the static client and the
// connect endpoint are public.
//
// The probe is a copy of apps/mcp/src/http-server.ts's `createDatabaseProbe`,
// not a shared module (copy-not-share between the two adapters, as in
// startup.ts): concurrent callers share one in-flight query, and each races
// it against its own timer. statement_timeout is no help: with
// connectionTimeoutMillis unset, pg-pool waits forever for a connection to
// a database that accepts TCP but never answers, so sharing the query caps
// what a hung database costs at one abandoned query, not one per request.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { createPool } from "@breakdown/db";
import { describeConnectionError } from "./startup.js";

type Pool = ReturnType<typeof createPool>;

export const HEALTH_TIMEOUT_MS = 2_000;

type ProbeResult = { ok: true } | { ok: false; error: string };

function createDatabaseProbe(pool: Pick<Pool, "query">, timeoutMs: number): () => Promise<ProbeResult> {
  let inflight: Promise<void> | undefined;

  return async () => {
    if (!inflight) {
      const query = Promise.resolve()
        .then(() => pool.query("select 1"))
        .then(() => undefined);
      inflight = query;
      // Handles the rejection too, so an abandoned query never surfaces as unhandled.
      const settle = (): void => {
        if (inflight === query) inflight = undefined;
      };
      query.then(settle, settle);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([inflight, timeout]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeConnectionError(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** The `/healthz` handler (module header). GET and HEAD only; HEAD answers the same status with no body. */
export function createHealthHandler(pool: Pick<Pool, "query">, timeoutMs: number = HEALTH_TIMEOUT_MS): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const probe = createDatabaseProbe(pool, timeoutMs);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...HEADERS, Allow: "GET, HEAD" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const result = await probe();
    const body = JSON.stringify(result.ok ? { ready: true } : { ready: false, error: result.error });
    res.writeHead(result.ok ? 200 : 503, HEADERS);
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
