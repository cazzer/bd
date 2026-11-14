// Entrypoint (bd-hmd.3): fail-fast startup checks, then serve the tRPC
// router over Node's http server, bound to loopback by default.
//
// One server, one dispatcher (dispatch.ts; board-visual-reviews, design.md
// decision 4): the shared admission function refuses a foreign Host or a
// foreign-Origin write with 403 and a request lacking a needed client token
// with 401, then `POST /auth/connect` goes to the connect handler
// (auth-connect.ts), a request under REVIEW_IMAGES_PREFIX to the review
// image handler (review-images.ts), and everything else to tRPC's
// standalone handler — the same `createHTTPHandler` that `createHTTPServer`
// wraps, so tRPC sees exactly what it saw before.
//
// Nothing above main() reads the environment or opens a connection —
// module scope only imports and defines main(); every side effect
// happens inside the function, at process startup (mirrors
// apps/mcp/src/index.ts's shape exactly).
//
// Bind address, port, and allowed hosts come from flags (http-args.ts;
// tailnet-hosting decision 1). The default bind is `127.0.0.1` explicitly,
// not `0.0.0.0` and not Node's default (which, with no host argument,
// listens on every interface) — with no flags, a request from another host
// on the network cannot reach this at all. `--host` widens the bind; even
// then a remote request needs a Host named by `--allow-host` and a client
// token (dispatch.ts), and a bind with no allowed host is warned about at
// startup.

import { verifyClientToken } from "@breakdown/core";
import { createDb, createPool, DatabaseUrlNotSetError, resolveDatabaseUrl } from "@breakdown/db";
import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createConnectHandler } from "./auth-connect.js";
import { createBeadsWatcher } from "./beads-watcher.js";
import { parseReadOnly } from "./config.js";
import { createContextFactory } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";
import { createReviewImageHandler } from "./review-images.js";
import { createHerdrJsonRunner, resolveHerdrSocket } from "./herdr-session.js";
import { bindWarning, parseWebArgs, WebArgsError, type WebArgs } from "./http-args.js";
import { resolveSessionCwd } from "./inbox-session.js";
import { createHerdrRunner, createReviewWriter } from "./review-writer.js";
import { appRouter } from "./router.js";
import { describeConnectionError, describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

async function main(): Promise<void> {
  // Flags first: a mistyped flag fails before anything connects.
  let args: WebArgs;
  try {
    args = parseWebArgs(process.argv.slice(2), process.env["WEB_SERVER_PORT"]);
  } catch (err) {
    if (!(err instanceof WebArgsError)) throw err;
    console.error(`[breakdown-web] cannot start: ${err.message}`);
    process.exit(1);
  }
  const warning = bindWarning(args);
  if (warning !== null) console.error(`[breakdown-web] warning: ${warning}`);

  let databaseUrl: string;
  try {
    // The only credential this server requires — see resolveDatabaseUrl,
    // which also loads the workspace-root .env and already produces an
    // actionable message (naming the .env path it looked for) when unset.
    databaseUrl = resolveDatabaseUrl();
  } catch (err) {
    const message = err instanceof DatabaseUrlNotSetError ? err.message : String(err);
    console.error(`[breakdown-web] cannot start: ${message}`);
    process.exit(1);
  }

  const pool = createPool(databaseUrl);

  try {
    await verifyDatabaseConnection(pool);
  } catch (err) {
    const target = describeConnectionTarget(databaseUrl);
    const detail = describeConnectionError(err);
    console.error(
      `[breakdown-web] cannot start: database at ${target} is unreachable (${detail}). ` +
        "Check that it is running and that DATABASE_URL is correct (see .env.example), then retry.",
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const db = createDb(pool);

  // Created after the pool and before the HTTP server (design decision 5);
  // start() returns once the registry is read — the first loads run in the
  // background so listening is not delayed — and logs/retries a registry
  // failure itself.
  const watcher = createBeadsWatcher({ db });
  const shutdown = new AbortController();
  await watcher.start();

  // BRAIN_READ_ONLY refuses every write procedure (review decisions, the
  // inbox, routers/write.ts) the way apps/mcp refuses its write tools.
  const readOnly = parseReadOnly(process.env["BRAIN_READ_ONLY"]);
  const reviewWriter = createReviewWriter();

  const { host, port, allowedHosts } = args;
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: createContextFactory(db, { watcher, shutdownSignal: shutdown.signal, readOnly, reviewWriter,
      runHerdr: createHerdrRunner(),
      herdrJson: createHerdrJsonRunner(),
      herdrSocket: resolveHerdrSocket(),
      sessionCwd: resolveSessionCwd(),
    }),
    basePath: "/trpc/",
  });
  const verifyToken = (token: string) => verifyClientToken(db, token);
  const server = createServer(
    createRequestDispatcher({
      port,
      allowedHosts,
      verifyToken,
      connect: createConnectHandler({ verifyToken }),
      reviewImages: createReviewImageHandler(),
      trpc: trpcHandler,
    }),
  );

  const hostPart = host.includes(":") ? `[${host}]` : host;
  server.listen(port, host, () => {
    const allowed = allowedHosts.length > 0 ? `, allowing ${allowedHosts.join(", ")}` : "";
    console.error(`[breakdown-web] ready on http://${hostPart}:${port}${allowed} — database ${describeConnectionTarget(databaseUrl)}${readOnly ? " (read-only)" : ""}`);
  });

  // One shared guard: a second signal while shutting down exits at once
  // (130) instead of running the sequence twice.
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      // Order matters (design decision 5): stop watchers/ticks, end
      // subscriptions (aborted while stop() is still waiting on in-flight
      // loads, so a subscriber never delays it), let in-flight loads finish
      // (they write through the pool), then close the server and only then
      // the pool.
      void (async () => {
        const stopping = watcher.stop();
        shutdown.abort();
        await stopping;
        server.close();
        server.closeAllConnections();
        await pool.end();
      })()
        .catch((err) => console.error("[breakdown-web] error during shutdown:", err))
        .finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("[breakdown-web] fatal error during startup:", err);
  process.exit(1);
});
