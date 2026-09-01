// Entrypoint: fail-fast startup checks, then serve the seven brain_* tools
// over stdio (brain-mcp spec, "Fail fast on misconfiguration").
//
// Nothing above main() reads the environment or opens a connection —
// module scope only defines main() and calls it; every side effect
// happens inside the function, at process startup, so this stays testable
// (server.ts's createServer() takes a Database it's handed, never resolves
// its own).

import { createDb, createPool, DatabaseUrlNotSetError, resolveDatabaseUrl } from "@breakdown/db";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseReadOnly } from "./config.js";
import { createServer } from "./server.js";
import { describeConnectionTarget, verifyDatabaseConnection } from "./startup.js";

async function main(): Promise<void> {
  let databaseUrl: string;
  try {
    // The only credential this server requires — see resolveDatabaseUrl,
    // which also loads the workspace-root .env and already produces an
    // actionable message (naming the .env path it looked for) when unset.
    databaseUrl = resolveDatabaseUrl();
  } catch (err) {
    const message = err instanceof DatabaseUrlNotSetError ? err.message : String(err);
    console.error(`[breakdown-brain] cannot start: ${message}`);
    process.exit(1);
  }

  const readOnly = parseReadOnly(process.env["BRAIN_READ_ONLY"]);
  const pool = createPool(databaseUrl);

  try {
    await verifyDatabaseConnection(pool);
  } catch (err) {
    const target = describeConnectionTarget(databaseUrl);
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[breakdown-brain] cannot start: database at ${target} is unreachable (${detail}). ` +
        "Check that it is running and that DATABASE_URL is correct (see .env.example), then retry.",
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const db = createDb(pool);
  const server = createServer(db, { readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[breakdown-brain] ready on stdio${readOnly ? " (read-only)" : ""} — database ${describeConnectionTarget(databaseUrl)}`);
}

main().catch((err) => {
  console.error("[breakdown-brain] fatal error during startup:", err);
  process.exit(1);
});
