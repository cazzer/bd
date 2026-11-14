// No model can mint a credential (tailnet-hosting, client-access spec:
// "No model can mint a credential"). Client tokens are created, listed, and
// revoked only by `pnpm -s client-token` on the host, so no MCP tool may be
// named for them and no tool source may reach the token store. Verifying a
// token is admission's job, in http-server.ts, never a tool's.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { allTools } from "./tools/index.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const TOKEN_STORE = /\b(createClientToken|createSessionToken|listClientTokens|revokeClientToken|revokeSessionTokens|verifyClientToken|clientTokens|client_tokens)\b|token-command/;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("the MCP surface holds no token operation", () => {
  test("no tool is named for tokens or credentials", () => {
    expect(allTools.length).toBeGreaterThan(0);
    expect(allTools.map((t) => t.name).filter((name) => /token|credential/i.test(name))).toEqual([]);
  });

  test("no tool source and not the server reaches the token store", () => {
    const files = [...sourcesUnder(join(SRC, "tools")), join(SRC, "server.ts")];
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((f) => TOKEN_STORE.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
