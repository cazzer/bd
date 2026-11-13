// `pnpm -s client-token create|list|revoke <client>` (tailnet-hosting, design
// decision 3), as a function over injected streams so tests drive it
// without a child process. token.ts is the thin entrypoint.
//
// stdout carries only the command's answer: for `create`, the token and a
// newline, nothing else, so `TOKEN=$(pnpm -s client-token create phone)`
// works. Notes and confirmations go to stderr. A token is never written
// anywhere but that one stdout line, and `list` never shows one.

import type { Database } from "@breakdown/db";
import { createClientToken, listClientTokens, revokeClientToken } from "../client-tokens.js";
import { ClientTokenExistsError, ClientTokenNotFoundError, InvalidClientNameError } from "../errors.js";

export interface TokenCliIo {
  db: Database;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = "usage: pnpm -s client-token create <client> | list | revoke <client>\n";

/** Runs one token command; resolves to the process exit code (0 ok, 1 refused, 2 usage). */
export async function runTokenCli(argv: readonly string[], { db, out, err }: TokenCliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "create" && rest.length === 1) {
      const created = await createClientToken(db, rest[0] as string);
      out(`${created.token}\n`);
      err(`token for ${created.client} created; it is shown once and cannot be recovered\n`);
      return 0;
    }
    if (command === "list" && rest.length === 0) {
      for (const row of await listClientTokens(db)) {
        const lastUsed = row.lastUsedAt === null ? "never" : row.lastUsedAt.toISOString();
        const state = row.revokedAt === null ? "live" : `revoked ${row.revokedAt.toISOString()}`;
        out(`${row.client}\tcreated ${row.createdAt.toISOString()}\tlast used ${lastUsed}\t${state}\n`);
      }
      return 0;
    }
    if (command === "revoke" && rest.length === 1) {
      const client = rest[0] as string;
      await revokeClientToken(db, client);
      err(`token for ${client} revoked\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof ClientTokenExistsError || e instanceof ClientTokenNotFoundError || e instanceof InvalidClientNameError) {
      err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
  err(USAGE);
  return 2;
}
