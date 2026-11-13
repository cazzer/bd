// client-tokens.ts against the real database (client-access spec, "Per-client
// tokens are minted and revoked locally", "Last use recorded"). Every test
// uses its own client names and deletes its own rows; none asserts on the
// table as a whole.

import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clientTokens, type Database } from "@breakdown/db";
import {
  createClientToken,
  listClientTokens,
  revokeClientToken,
  verifyClientToken,
} from "./client-tokens.js";
import { ClientTokenExistsError, ClientTokenNotFoundError, InvalidClientNameError } from "./errors.js";
import { connectTestDb, uniqueSuffix, type TestPool } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
const created: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  const clients = created.splice(0);
  if (clients.length > 0) await db.delete(clientTokens).where(inArray(clientTokens.client, clients));
});

afterAll(async () => {
  await pool.end();
});

function clientName(label = "c"): string {
  const name = `tok-${label}-${uniqueSuffix().slice(0, 16)}`;
  created.push(name);
  return name;
}

async function lastUsedAt(client: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastUsedAt: clientTokens.lastUsedAt })
    .from(clientTokens)
    .where(eq(clientTokens.client, client));
  if (!row) throw new Error(`no row for ${client}`);
  return row.lastUsedAt;
}

describe("createClientToken", () => {
  it("returns a bdt_ token of 32 random bytes in base64url", async () => {
    const client = clientName();
    const result = await createClientToken(db, client, "human");
    expect(result.client).toBe(client);
    expect(result.scope).toBe("human");
    expect(result.token).toMatch(/^bdt_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.token.slice(4), "base64url")).toHaveLength(32);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("stores sha256(token) and no column holds the token text", async () => {
    const client = clientName();
    const { token } = await createClientToken(db, client, "human");
    const result = await db.execute<Record<string, unknown>>(sql`SELECT * FROM client_tokens WHERE client = ${client}`);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as Record<string, unknown>;

    const stored = row["token_hash"] as Buffer;
    expect(Buffer.compare(stored, createHash("sha256").update(token).digest())).toBe(0);
    for (const [column, value] of Object.entries(row)) {
      const texts = Buffer.isBuffer(value)
        ? [value.toString("utf8"), value.toString("hex"), value.toString("base64"), value.toString("base64url")]
        : [String(value)];
      for (const text of texts) expect(text.includes(token.slice(4)), column).toBe(false);
    }
  });

  it("refuses a second live token for the client, naming it and the revoke command", async () => {
    const client = clientName();
    await createClientToken(db, client, "human");
    const refused = await createClientToken(db, client, "human").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ClientTokenExistsError);
    expect((refused as Error).message).toContain(client);
    expect((refused as Error).message).toContain(`pnpm -s client-token revoke ${client}`);
  });

  it.each(["", "-leading-dash", ".dot", "has space", "slash/name", "a".repeat(65), "naïve"])(
    "refuses the client name %j without writing",
    async (name) => {
      await expect(createClientToken(db, name, "human")).rejects.toBeInstanceOf(InvalidClientNameError);
    },
  );

  it("accepts a 64-character name of letters, digits, dot, underscore, and dash", async () => {
    const base = clientName("n");
    const name = `${base}._-`.padEnd(64, "x");
    created.push(name);
    await expect(createClientToken(db, name, "human")).resolves.toMatchObject({ client: name });
  });
});

describe("listClientTokens", () => {
  it("never carries a hash or token, and shows revoked rows", async () => {
    const live = clientName("live");
    const gone = clientName("gone");
    await createClientToken(db, live, "human");
    await createClientToken(db, gone, "human");
    await revokeClientToken(db, gone);

    const rows = (await listClientTokens(db)).filter((r) => r.client === live || r.client === gone);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["client", "createdAt", "lastUsedAt", "revokedAt", "scope"]);
    }
    expect(rows.find((r) => r.client === live)?.revokedAt).toBeNull();
    expect(rows.find((r) => r.client === gone)?.revokedAt).toBeInstanceOf(Date);
  });
});

describe("revokeClientToken", () => {
  it("revokes a live token, then refuses a second revoke as not found", async () => {
    const client = clientName();
    await createClientToken(db, client, "human");
    await revokeClientToken(db, client);
    await expect(revokeClientToken(db, client)).rejects.toBeInstanceOf(ClientTokenNotFoundError);
  });

  it("refuses a client that never had a token", async () => {
    await expect(revokeClientToken(db, clientName())).rejects.toBeInstanceOf(ClientTokenNotFoundError);
  });
});

describe("verifyClientToken", () => {
  it("names the client of a live token, and null once it is revoked", async () => {
    const client = clientName();
    const { token } = await createClientToken(db, client, "human");
    expect(await verifyClientToken(db, token)).toEqual({ client, scope: "human" });
    await revokeClientToken(db, client);
    expect(await verifyClientToken(db, token)).toBeNull();
  });

  it("returns null for an unknown or malformed token", async () => {
    const unknown = `bdt_${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(await verifyClientToken(db, unknown)).toBeNull();
    expect(await verifyClientToken(db, "")).toBeNull();
    expect(await verifyClientToken(db, "not-a-token")).toBeNull();
    expect(await verifyClientToken(db, `bdt_${"a".repeat(200)}`)).toBeNull();
  });

  it("refuses anything but the exact minted shape without querying", async () => {
    const noQuery = {
      execute: () => {
        throw new Error("verifyClientToken queried for a malformed token");
      },
    } as unknown as Database;
    const body = "A".repeat(43);
    for (const token of [`bdt_${body.slice(1)}`, `bdt_${body}A`, `bdt_${body.slice(1)}=`, `BDT_${body}`, `bdt_${body}\n`, ` bdt_${body}`]) {
      expect(await verifyClientToken(noQuery, token)).toBeNull();
    }
  });

  it("does not admit a live token's text without its prefix", async () => {
    const client = clientName();
    const { token } = await createClientToken(db, client, "human");
    expect(await verifyClientToken(db, token.slice(4))).toBeNull();
  });

  it("sets last_used_at on first use", async () => {
    const client = clientName();
    const { token } = await createClientToken(db, client, "human");
    expect(await lastUsedAt(client)).toBeNull();
    await verifyClientToken(db, token);
    expect(await lastUsedAt(client)).toBeInstanceOf(Date);
  });

  it("touches last_used_at only when it is more than 60 seconds old", async () => {
    const client = clientName();
    const { token } = await createClientToken(db, client, "human");

    await db
      .update(clientTokens)
      .set({ lastUsedAt: sql`now() - interval '2 minutes'` })
      .where(eq(clientTokens.client, client));
    const stale = await lastUsedAt(client);
    await verifyClientToken(db, token);
    const moved = await lastUsedAt(client);
    expect(moved!.getTime() - stale!.getTime()).toBeGreaterThan(100_000);

    await db
      .update(clientTokens)
      .set({ lastUsedAt: sql`now() - interval '10 seconds'` })
      .where(eq(clientTokens.client, client));
    const recent = await lastUsedAt(client);
    await verifyClientToken(db, token);
    expect((await lastUsedAt(client))!.getTime()).toBe(recent!.getTime());
  });

  it("returns an agent token's scope", async () => {
    const client = clientName("agent");
    const created = await createClientToken(db, client, "agent");
    expect(created.scope).toBe("agent");
    expect(await verifyClientToken(db, created.token)).toEqual({ client, scope: "agent" });
    const [listed] = (await listClientTokens(db)).filter((r) => r.client === client);
    expect(listed?.scope).toBe("agent");
  });

  it("after a re-issue, the old token is refused and the new one admitted", async () => {
    const client = clientName();
    const first = await createClientToken(db, client, "human");
    await revokeClientToken(db, client);
    const second = await createClientToken(db, client, "human");
    expect(second.token).not.toBe(first.token);
    expect(await verifyClientToken(db, first.token)).toBeNull();
    expect(await verifyClientToken(db, second.token)).toEqual({ client, scope: "human" });
  });
});
