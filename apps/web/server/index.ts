// Entrypoint (bd-hmd.3): fail-fast startup checks, then serve the tRPC
// router over Node's http server, bound to loopback only.
//
// Nothing above main() reads the environment or opens a connection —
// module scope only imports and defines main(); every side effect
// happens inside the function, at process startup (mirrors
// apps/mcp/src/index.ts's shape exactly).
//
// Binds `127.0.0.1` explicitly, not `0.0.0.0` and not Node's default
// (which, with no host argument, listens on every interface) — the local
// web spec's "Server binds to loopback" scenario requires that a request
// from another host on the network cannot reach this at all, not merely
// that it isn't advertised.

import { createDb, createPool, DatabaseUrlNotSetError, resolveDatabaseUrl } from "@breakdown/db";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { createBeadsWatcher } from "./beads-watcher.js";
import { createContextFactory } from "./context.js";
import { appRouter } from "./router.js";
import { describeConnectionError, describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

/** Loopback-only: see the module header. Not configurable — there is no scenario in which this server should listen anywhere else. */
const HOST = "127.0.0.1";

/** Overridable via `WEB_SERVER_PORT` — vite.config.ts's dev proxy target must agree with this. */
const DEFAULT_PORT = 4310;

async function main(): Promise<void> {
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

  const port = Number(process.env["WEB_SERVER_PORT"] ?? DEFAULT_PORT);
  const server = createHTTPServer({
    router: appRouter,
    createContext: createContextFactory(db, { watcher, shutdownSignal: shutdown.signal }),
    basePath: "/trpc/",
  });

  server.listen(port, HOST, () => {
    console.error(`[breakdown-web] ready on http://${HOST}:${port} — database ${describeConnectionTarget(databaseUrl)}`);
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
