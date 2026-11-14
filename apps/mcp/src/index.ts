// Stdio entrypoint: the shared fail-fast startup (bootstrap.ts), then the
// fourteen brain_* tools over stdio. Every startup step lives in bootstrap.ts
// so this entrypoint and the HTTP one differ only in transport (design.md
// decision 1).
//
// Nothing above main() reads the environment or opens a connection —
// module scope only defines main() and calls it; every side effect
// happens inside the function, at process startup, so this stays testable
// (server.ts's createServer() takes a Database it's handed, never resolves
// its own; bootstrap.ts likewise does nothing at import).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap } from "./bootstrap.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const { db, readOnly, target } = await bootstrap();
  const server = createServer(db, { readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[breakdown-brain] ready on stdio${readOnly ? " (read-only)" : ""} — database ${target}`);
}

main().catch((err) => {
  console.error("[breakdown-brain] fatal error during startup:", err);
  process.exit(1);
});
