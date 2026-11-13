// `pnpm -s client-token create <client> --scope human|agent | list | revoke
// <client>`: the entrypoint for
// token-command.ts. It owns the pool's lifecycle and the exit code; nothing
// connects at module scope beyond `main()`, and nothing imports this file.

import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import { runTokenCli } from "./token-command.js";

async function main(): Promise<void> {
  const pool = createPool(resolveDatabaseUrl());
  try {
    process.exitCode = await runTokenCli(process.argv.slice(2), {
      db: createDb(pool),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[client-token] failed:", err);
  process.exitCode = 1;
});
