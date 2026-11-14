// No model can mint a credential (tailnet-hosting, client-access spec:
// "No model can mint a credential"). Client tokens are created, listed, and
// revoked only by `pnpm -s client-token` on the host, so no tRPC procedure
// may be named for them and no router source may reach the token store.
// Verifying a token is admission's job, in dispatch.ts and index.ts, never
// a procedure's.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { appRouter } from "./router.js";

const SERVER = dirname(fileURLToPath(import.meta.url));
const TOKEN_STORE = /\b(createClientToken|createSessionToken|listClientTokens|revokeClientToken|revokeSessionTokens|verifyClientToken|clientTokens|client_tokens)\b|token-command/;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("the tRPC surface holds no token operation", () => {
  test("no procedure is named for tokens or credentials", () => {
    const names = Object.keys(appRouter._def.procedures);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /token|credential/i.test(name))).toEqual([]);
  });

  test("no router source reaches the token store", () => {
    const files = [...sourcesUnder(join(SERVER, "routers")), join(SERVER, "router.ts")];
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((f) => TOKEN_STORE.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
