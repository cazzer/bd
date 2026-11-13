// admission.ts (client-access spec: "Exposure beyond loopback is opt-in",
// "Off-loopback requests carry a client token", "Browsers connect with a
// cookie, not a URL"; design decision 2). Pure: the token store is a fake
// that counts its calls, so a test can prove a refusal never reached it.

import { describe, expect, it } from "vitest";
import {
  admitRequest,
  credentialFrom,
  forwardedAddressesFrom,
  isLoopbackAddress,
  normalizeAllowedHost,
  type AdmissionPolicy,
  type AdmissionRequest,
} from "./admission.js";

const PORT = 5320;
const TAILNET = "breakdown.tail.example";
const LIVE: Record<string, { client: string; scope: "human" | "agent" }> = {
  bdt_worker: { client: "worker-1", scope: "agent" },
  bdt_phone: { client: "phone", scope: "human" },
};

function fakeStore() {
  const calls: string[] = [];
  return {
    calls,
    verifyToken: async (token: string) => {
      calls.push(token);
      return LIVE[token] ?? null;
    },
  };
}

function policy(overrides: Partial<AdmissionPolicy> = {}) {
  const store = fakeStore();
  const value: AdmissionPolicy = {
    port: PORT,
    allowedHosts: [TAILNET],
    originCheck: "unsafe-methods",
    scopes: ["human", "agent"],
    isPublic: (method, path) => method === "POST" && path === "/auth/connect",
    verifyToken: store.verifyToken,
    ...overrides,
  };
  return { policy: value, calls: store.calls };
}

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    method: "GET",
    host: `${TAILNET}:${PORT}`,
    origin: undefined,
    peerIsLoopback: false,
    path: "/trpc/board",
    credential: undefined,
    forwardedFor: undefined,
    ...overrides,
  };
}

const bearer = (token: string) => ({ token, source: "bearer" as const });
const cookie = (token: string) => ({ token, source: "cookie" as const });

describe("admitRequest", () => {
  it("trusts a loopback peer with a loopback Host, without consulting the store", async () => {
    for (const host of ["127.0.0.1:5320", "localhost:5320", "[::1]:5320"]) {
      const { policy: p, calls } = policy();
      expect(await admitRequest(request({ host, peerIsLoopback: true }), p), host).toEqual({ outcome: "allow", client: null });
      expect(calls).toHaveLength(0);
    }
  });

  it("admits a tailnet Host with a live bearer token as that client", async () => {
    const { policy: p, calls } = policy();
    expect(await admitRequest(request({ credential: bearer("bdt_worker") }), p)).toEqual({ outcome: "allow", client: "worker-1" });
    expect(calls).toEqual(["bdt_worker"]);
  });

  it("refuses a foreign Host with or without a token, before the store", async () => {
    for (const credential of [undefined, bearer("bdt_worker")]) {
      const { policy: p, calls } = policy();
      expect(await admitRequest(request({ host: `evil.example:${PORT}`, credential }), p)).toEqual({ outcome: "forbidden" });
      expect(await admitRequest(request({ host: `evil.example:${PORT}`, credential, peerIsLoopback: true }), p)).toEqual({
        outcome: "forbidden",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a missing Host, a loopback Host with no port, and one on the wrong port", async () => {
    const { policy: p, calls } = policy();
    for (const host of [undefined, "", `${TAILNET}:5321`, `${TAILNET}:`, `${TAILNET}:05320x`, "127.0.0.1", "localhost", "[::1]", "127.0.0.1:5321"]) {
      expect(await admitRequest(request({ host, peerIsLoopback: true, credential: bearer("bdt_worker") }), p), String(host)).toEqual({
        outcome: "forbidden",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts `[::1]` and case-folds the Host", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ host: "[::1]:5320", peerIsLoopback: true }), p)).toEqual({ outcome: "allow", client: null });
    expect(await admitRequest(request({ host: "LOCALHOST:5320", peerIsLoopback: true }), p)).toEqual({ outcome: "allow", client: null });
    expect(await admitRequest(request({ host: `BreakDown.Tail.Example:${PORT}`, credential: bearer("bdt_phone") }), p)).toEqual({
      outcome: "allow",
      client: "phone",
    });
  });

  it("answers 401 for a missing token", async () => {
    const { policy: p, calls } = policy();
    expect(await admitRequest(request(), p)).toEqual({ outcome: "unauthorized" });
    expect(calls).toHaveLength(0);
  });

  it("answers 401 for an unknown or revoked token, exactly as for a missing one", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ credential: bearer("bdt_unknown") }), p)).toEqual({ outcome: "unauthorized" });
    expect(await admitRequest(request({ credential: cookie("bdt_revoked") }), p)).toEqual({ outcome: "unauthorized" });
  });

  it("requires a token from a loopback peer that sends a tailnet Host", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ peerIsLoopback: true }), p)).toEqual({ outcome: "unauthorized" });
    expect(await admitRequest(request({ peerIsLoopback: true, credential: bearer("bdt_worker") }), p)).toEqual({
      outcome: "allow",
      client: "worker-1",
    });
  });

  it("requires a token from a non-loopback peer that sends a loopback Host", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ host: "127.0.0.1:5320" }), p)).toEqual({ outcome: "unauthorized" });
  });

  it("refuses a foreign Origin on a POST under both policies", async () => {
    for (const originCheck of ["unsafe-methods", "all-methods"] as const) {
      const { policy: p, calls } = policy({ originCheck });
      const req = request({ method: "POST", origin: "https://evil.example", credential: bearer("bdt_worker") });
      expect(await admitRequest(req, p), originCheck).toEqual({ outcome: "forbidden" });
      expect(await admitRequest({ ...req, host: "127.0.0.1:5320", peerIsLoopback: true }, p), originCheck).toEqual({
        outcome: "forbidden",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("lets a foreign Origin GET through on the web policy but not on MCP's", async () => {
    const req = request({ method: "GET", origin: "https://evil.example", credential: bearer("bdt_worker") });
    expect(await admitRequest(req, policy({ originCheck: "unsafe-methods" }).policy)).toEqual({ outcome: "allow", client: "worker-1" });
    expect(await admitRequest(req, policy({ originCheck: "all-methods" }).policy)).toEqual({ outcome: "forbidden" });
  });

  it("refuses `Origin: null` and an unparseable or non-http Origin", async () => {
    const { policy: p } = policy();
    for (const origin of ["null", "not a url", "file:///etc", "ftp://localhost:21", "http://localhost:1/path", "http://127.0.0.1.evil.example:80"]) {
      const req = request({ method: "POST", host: "127.0.0.1:5320", peerIsLoopback: true, origin });
      expect(await admitRequest(req, p), origin).toEqual({ outcome: "forbidden" });
    }
  });

  it("allows loopback Origins on any port, http or https", async () => {
    const { policy: p } = policy();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:1", "http://[::1]:5320", "HTTP://LOCALHOST:5173", "http://[0:0:0:0:0:0:0:1]:9"]) {
      const req = request({ method: "POST", origin, credential: bearer("bdt_worker") });
      expect(await admitRequest(req, p), origin).toEqual({ outcome: "allow", client: "worker-1" });
    }
  });

  it("pins an allowed name's Origin to the server's port or the scheme's default", async () => {
    const { policy: p } = policy();
    for (const origin of [`http://${TAILNET}:${PORT}`, `https://${TAILNET}:${PORT}`, `https://${TAILNET}`, `http://${TAILNET}`, `http://${TAILNET}:80`, `https://${TAILNET}:443`]) {
      const req = request({ method: "POST", origin, credential: bearer("bdt_worker") });
      expect(await admitRequest(req, p), origin).toEqual({ outcome: "allow", client: "worker-1" });
    }
    for (const origin of [`http://${TAILNET}:8080`, `http://${TAILNET}:443`, `https://${TAILNET}:80`, `http://${TAILNET}:5321`]) {
      const req = request({ method: "POST", origin, credential: cookie("bdt_phone") });
      expect(await admitRequest(req, p), origin).toEqual({ outcome: "forbidden" });
    }
  });

  it("admits POST /auth/connect from a tailnet Host with no token", async () => {
    const { policy: p, calls } = policy();
    const req = request({ method: "POST", path: "/auth/connect", origin: `http://${TAILNET}:${PORT}` });
    expect(await admitRequest(req, p)).toEqual({ outcome: "allow", client: null });
    expect(calls).toHaveLength(0);
  });

  it("does not treat GET /auth/connect as public", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ method: "GET", path: "/auth/connect" }), p)).toEqual({ outcome: "unauthorized" });
  });

  it("still refuses a public path under a foreign Host or Origin", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ method: "POST", path: "/auth/connect", host: `evil.example:${PORT}` }), p)).toEqual({
      outcome: "forbidden",
    });
    expect(await admitRequest(request({ method: "POST", path: "/auth/connect", origin: "https://evil.example" }), p)).toEqual({
      outcome: "forbidden",
    });
  });

  it("upper-cases the method it hands isPublic", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ method: "post", path: "/auth/connect" }), p)).toEqual({ outcome: "allow", client: null });
  });

  it("refuses a cookie on a checked method that carries no Origin", async () => {
    const { policy: p, calls } = policy();
    expect(await admitRequest(request({ method: "POST", credential: cookie("bdt_phone") }), p)).toEqual({ outcome: "forbidden" });
    expect(calls).toHaveLength(0);
    const mcp = policy({ originCheck: "all-methods" });
    expect(await admitRequest(request({ method: "GET", credential: cookie("bdt_phone") }), mcp.policy)).toEqual({ outcome: "forbidden" });
  });

  it("admits a cookie on a GET without Origin on the web policy, and on a POST with an allowed Origin", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ method: "GET", credential: cookie("bdt_phone") }), p)).toEqual({ outcome: "allow", client: "phone" });
    expect(
      await admitRequest(request({ method: "POST", origin: `http://${TAILNET}:${PORT}`, credential: cookie("bdt_phone") }), p),
    ).toEqual({ outcome: "allow", client: "phone" });
  });

  it("admits a bearer POST with no Origin", async () => {
    const { policy: p } = policy({ originCheck: "all-methods" });
    expect(await admitRequest(request({ method: "POST", credential: bearer("bdt_worker") }), p)).toEqual({ outcome: "allow", client: "worker-1" });
  });

  it("admits an allowed name with no port (a fronting proxy), never a bare loopback name", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ host: TAILNET, credential: bearer("bdt_phone") }), p)).toEqual({ outcome: "allow", client: "phone" });
    expect(await admitRequest(request({ host: TAILNET.toUpperCase() }), p)).toEqual({ outcome: "unauthorized" });
    const listsLoopback = policy({ allowedHosts: [TAILNET, "localhost", "127.0.0.1"] }).policy;
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(await admitRequest(request({ host, peerIsLoopback: true }), listsLoopback), host).toEqual({ outcome: "forbidden" });
    }
  });

  it("canonicalizes a bracketed IPv6 Host before matching", async () => {
    const { policy: p } = policy({ allowedHosts: ["[fd7a:115c::1]"] });
    expect(await admitRequest(request({ host: "[0:0:0:0:0:0:0:1]:5320", peerIsLoopback: true }), p)).toEqual({ outcome: "allow", client: null });
    expect(await admitRequest(request({ host: "[FD7A:115C:0:0:0:0:0:1]:5320", credential: bearer("bdt_phone") }), p)).toEqual({
      outcome: "allow",
      client: "phone",
    });
    expect(await admitRequest(request({ host: "[fd7a:115c::1]", credential: bearer("bdt_phone") }), p)).toEqual({ outcome: "allow", client: "phone" });
    for (const host of ["[fd7a:115c::2]:5320", "[not-v6]:5320", "[::1:5320", "::1:5320", "[fe80::1%25en0]:5320"]) {
      expect(await admitRequest(request({ host, peerIsLoopback: true, credential: bearer("bdt_phone") }), p), host).toEqual({ outcome: "forbidden" });
    }
  });

  it("refuses a live token outside the policy's scopes with 403", async () => {
    const { policy: p, calls } = policy({ scopes: ["human"] });
    expect(await admitRequest(request({ credential: bearer("bdt_worker") }), p)).toEqual({ outcome: "forbidden" });
    expect(await admitRequest(request({ credential: cookie("bdt_worker") }), p)).toEqual({ outcome: "forbidden" });
    expect(await admitRequest(request({ credential: bearer("bdt_phone") }), p)).toEqual({ outcome: "allow", client: "phone" });
    expect(await admitRequest(request({ credential: bearer("bdt_unknown") }), p)).toEqual({ outcome: "unauthorized" });
    expect(calls).toEqual(["bdt_worker", "bdt_worker", "bdt_phone", "bdt_unknown"]);
  });

  it("keeps loopback trust when every forwarded address is loopback", async () => {
    const { policy: p, calls } = policy();
    for (const forwardedFor of [["127.0.0.1"], ["::1", "127.0.0.1"]]) {
      expect(await admitRequest(request({ host: "127.0.0.1:5320", peerIsLoopback: true, forwardedFor }), p)).toEqual({ outcome: "allow", client: null });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a token from a loopback peer whose forwarding header names a remote address", async () => {
    const { policy: p } = policy();
    for (const forwardedFor of [["100.64.0.9"], ["127.0.0.1", "100.64.0.9"], ["unknown"], ["_hidden"], [""]]) {
      const req = request({ host: "127.0.0.1:5320", peerIsLoopback: true, forwardedFor });
      expect(await admitRequest(req, p), forwardedFor.join(",")).toEqual({ outcome: "unauthorized" });
      expect(await admitRequest({ ...req, credential: bearer("bdt_phone") }, p)).toEqual({ outcome: "allow", client: "phone" });
    }
  });

  it("treats a missing method as GET", async () => {
    const { policy: p } = policy();
    expect(await admitRequest(request({ method: undefined, origin: "https://evil.example", credential: bearer("bdt_worker") }), p)).toEqual({
      outcome: "allow",
      client: "worker-1",
    });
  });
});

describe("credentialFrom", () => {
  it("prefers a bearer header over the cookie", () => {
    expect(credentialFrom({ authorization: "Bearer bdt_a", cookie: "breakdown_token=bdt_b" })).toEqual({ token: "bdt_a", source: "bearer" });
    expect(credentialFrom({ authorization: "bearer  bdt_a " })).toEqual({ token: "bdt_a", source: "bearer" });
  });

  it("ignores a non-bearer Authorization and falls back to the cookie", () => {
    expect(credentialFrom({ authorization: "Basic dXNlcjpwYXNz" })).toBeUndefined();
    expect(credentialFrom({ authorization: "Basic dXNlcjpwYXNz", cookie: "breakdown_token=bdt_b" })).toEqual({ token: "bdt_b", source: "cookie" });
    expect(credentialFrom({ authorization: "Bearer" })).toBeUndefined();
  });

  it("finds the token cookie among others", () => {
    expect(credentialFrom({ cookie: "theme=dark; breakdown_token=bdt_c; other=1" })).toEqual({ token: "bdt_c", source: "cookie" });
    expect(credentialFrom({ cookie: ["a=1", "breakdown_token=bdt_d"] })).toEqual({ token: "bdt_d", source: "cookie" });
  });

  it("finds nothing in an unrelated or empty cookie", () => {
    expect(credentialFrom({})).toBeUndefined();
    expect(credentialFrom({ cookie: "not_breakdown_token=bdt_x; breakdown_token_old=bdt_y" })).toBeUndefined();
    expect(credentialFrom({ cookie: "breakdown_token=" })).toBeUndefined();
  });
});

describe("forwardedAddressesFrom", () => {
  it("is undefined with no forwarding header", () => {
    expect(forwardedAddressesFrom({})).toBeUndefined();
  });

  it("lists every X-Forwarded-For entry, ports and brackets stripped", () => {
    expect(forwardedAddressesFrom({ "x-forwarded-for": "100.64.0.9, 127.0.0.1:5000, [::1]:80, ::1" })).toEqual(["100.64.0.9", "127.0.0.1", "::1", "::1"]);
    expect(forwardedAddressesFrom({ "x-forwarded-for": ["127.0.0.1", "10.0.0.1"] })).toEqual(["127.0.0.1", "10.0.0.1"]);
  });

  it("includes X-Real-IP", () => {
    expect(forwardedAddressesFrom({ "x-real-ip": "100.64.0.9" })).toEqual(["100.64.0.9"]);
  });

  it("reads each Forwarded element's for=, quoted or not", () => {
    expect(
      forwardedAddressesFrom({ forwarded: 'for=127.0.0.1;proto=http, For="[::1]:4711";by=203.0.113.43, proto=https;for="100.64.0.9"' }),
    ).toEqual(["127.0.0.1", "::1", "100.64.0.9"]);
  });

  it("keeps unknown, obfuscated, and for-less entries so they fail closed", () => {
    const addresses = forwardedAddressesFrom({ forwarded: "for=unknown, for=_hidden, proto=https", "x-forwarded-for": "127.0.0.1," });
    expect(addresses).toEqual(["127.0.0.1", "", "unknown", "_hidden", ""]);
    expect(addresses!.every(isLoopbackAddress)).toBe(false);
    expect(forwardedAddressesFrom({ forwarded: "for=unknown" })!.every(isLoopbackAddress)).toBe(false);
  });
});

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.9"])("accepts %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(["0.0.0.0", "192.168.1.5", "::", "::ffff:192.168.1.5", "128.0.0.1", "127.0.0.1.evil", "fe80::1", "", undefined])("refuses %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("normalizeAllowedHost", () => {
  it.each([
    ["breakdown.tail.example", "breakdown.tail.example"],
    ["BreakDown.Tail.Example", "breakdown.tail.example"],
    ["jetson", "jetson"],
    ["100.64.1.2", "100.64.1.2"],
    ["[FD7A:115C:A1E0::1]", "[fd7a:115c:a1e0::1]"],
    ["[fd7a:115c:0:0:0:0:0:1]", "[fd7a:115c::1]"],
  ])("accepts %s as %s", (value, expected) => {
    expect(normalizeAllowedHost(value)).toBe(expected);
  });

  it.each(["", "   ", "*", "*.tail.example", "breakdown.tail.example:5320", "http://breakdown.tail.example", "breakdown.tail.example/path", "fd7a::1", "[fd7a::1]:5320", "[not-v6]", "-bad.example", "under_score.example"])(
    "refuses %j",
    (value) => {
      expect(() => normalizeAllowedHost(value)).toThrow(/invalid allowed host/);
    },
  );
});
