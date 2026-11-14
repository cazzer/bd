// `pnpm -s client-token create <client> --scope human|agent|hangar | list |
// revoke <client>` (tailnet-hosting, design decisions 3 and 9; hangar-queue
// decisions 1 and 4), as a function over injected streams so tests drive it
// without a child process. token.ts is the thin entrypoint.
//
// stdout carries only the command's answer: for `create`, the token and a
// newline, nothing else, so `TOKEN=$(pnpm -s client-token create phone
// --scope human)` works. The scope has no default: an operator states
// whether a token is a person's (web and MCP), an agent's (MCP and the agent
// procedures), or the hangar service's (the hangar endpoints only). `list`
// shows each row's bound hangar session, if any: session tokens are minted
// by a hangar claim, never here. Notes and confirmations go to stderr. A token is never written
// anywhere but that one stdout line, and `list` never shows one.

import type { ClientTokenScope, Database } from "@breakdown/db";
import { createClientToken, isClientTokenScope, listClientTokens, revokeClientToken } from "../client-tokens.js";
import { ClientTokenExistsError, ClientTokenNotFoundError, InvalidClientNameError, ReservedClientNameError } from "../errors.js";

export interface TokenCliIo {
  db: Database;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE =
  "usage: pnpm -s client-token create <client> --scope human|agent|hangar | list | revoke <client>\n" +
  "  --scope human: a person's device (phone, laptop); admitted by the web API and MCP\n" +
  "  --scope agent: a worker or driver; admitted by MCP and the agent procedures of the web API\n" +
  "  --scope hangar: the hangar service; admitted by /hangar/v1 only\n";

/** `<client> --scope <scope>` in either order, or undefined for anything else. */
function parseCreateArgs(rest: readonly string[]): { client: string; scope: ClientTokenScope } | undefined {
  if (rest.length !== 3) return undefined;
  const flagAt = rest.indexOf("--scope");
  if (flagAt === -1 || flagAt === 2) return undefined;
  const scope = rest[flagAt + 1] as string;
  const client = rest[flagAt === 0 ? 2 : 0] as string;
  if (!isClientTokenScope(scope) || client.startsWith("-")) return undefined;
  return { client, scope };
}

/** Runs one token command; resolves to the process exit code (0 ok, 1 refused, 2 usage). */
export async function runTokenCli(argv: readonly string[], { db, out, err }: TokenCliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "create") {
      const parsed = parseCreateArgs(rest);
      if (parsed !== undefined) {
        const created = await createClientToken(db, parsed.client, parsed.scope);
        out(`${created.token}\n`);
        err(`${created.scope} token for ${created.client} created; it is shown once and cannot be recovered\n`);
        return 0;
      }
    }
    if (command === "list" && rest.length === 0) {
      for (const row of await listClientTokens(db)) {
        const lastUsed = row.lastUsedAt === null ? "never" : row.lastUsedAt.toISOString();
        const state = row.revokedAt === null ? "live" : `revoked ${row.revokedAt.toISOString()}`;
        const session = row.sessionId === null ? "-" : `session ${row.sessionId}`;
        out(`${row.client}\t${row.scope}\t${session}\tcreated ${row.createdAt.toISOString()}\tlast used ${lastUsed}\t${state}\n`);
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
    if (e instanceof ClientTokenExistsError || e instanceof ClientTokenNotFoundError || e instanceof InvalidClientNameError || e instanceof ReservedClientNameError) {
      err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
  err(USAGE);
  return 2;
}
