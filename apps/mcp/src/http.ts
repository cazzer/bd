// HTTP entrypoint (design.md decision 1): flags (http-config.ts), the
// shared fail-fast startup (bootstrap.ts), then the brain_* tools over
// Streamable HTTP (http-server.ts). Started by `pnpm mcp:serve` or, under a
// supervisor, `tsx apps/mcp/src/http.ts --port <n> --host <addr>`.
//
// Flags are parsed before bootstrap, so a bad flag exits without touching
// the database. Everything is logged to stderr, as in stdio mode. Nothing
// above main() reads the environment or opens a connection.

import { bootstrap } from "./bootstrap.js";
import { parseHttpArgs, type HttpConfig } from "./http-config.js";
import { startHttpServer, type RunningHttpServer } from "./http-server.js";

/** Covers close() (at most SHUTDOWN_GRACE_MS plus a flush) and pool.end(). */
const SHUTDOWN_DEADLINE_MS = 5_000;

function cannotStart(message: string): never {
  console.error(`[breakdown-brain] cannot start: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = parseHttpArgs(process.argv.slice(2));
  } catch (err) {
    cannotStart(err instanceof Error ? err.message : String(err));
  }

  const { db, pool, readOnly, target } = await bootstrap();

  let running: RunningHttpServer;
  try {
    running = await startHttpServer({ db, pool, readOnly, target, port: config.port, host: config.host });
  } catch (err) {
    await pool.end().catch(() => {});
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      cannotStart(`port ${config.port} on ${config.host} is already in use. Stop the other process or pass --port <n>.`);
    }
    cannotStart(err instanceof Error ? err.message : String(err));
  }

  // A second signal, or a shutdown that overruns its deadline, exits 1
  // without waiting: the operator (or supervisor) asked twice.
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      console.error(`[breakdown-brain] second ${signal} received, exiting without finishing shutdown`);
      process.exit(1);
    }
    stopping = true;
    console.error(`[breakdown-brain] ${signal} received, closing sessions`);
    setTimeout(() => {
      console.error(`[breakdown-brain] shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms, exiting`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    running
      .close()
      .then(() => pool.end())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error("[breakdown-brain] error during shutdown:", err);
          process.exit(1);
        },
      );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.error(`[breakdown-brain] ready on ${running.url}${readOnly ? " (read-only)" : ""} — database ${target}`);
}

main().catch((err) => {
  console.error("[breakdown-brain] fatal error during startup:", err);
  process.exit(1);
});
