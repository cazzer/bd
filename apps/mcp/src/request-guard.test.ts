// request-guard.ts (brain-mcp spec, "HTTP mode is local only" → "DNS
// rebinding", "Cross-site browser request"). http-server.test.ts covers
// the guard wired into the real server.

import { describe, expect, it } from "vitest";
import { isAllowedRequest, isLoopbackAddress } from "./request-guard.js";

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.9"])("accepts %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each(["0.0.0.0", "192.168.1.5", "::", "::ffff:192.168.1.5", "128.0.0.1", "127.0.0.1.evil", "fe80::1", "", undefined])("refuses %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

const PORT = 5320;

describe("isAllowedRequest", () => {
  it("allows each loopback Host with no Origin", () => {
    for (const host of ["127.0.0.1:5320", "localhost:5320", "[::1]:5320"]) {
      expect(isAllowedRequest({ host, origin: undefined }, PORT), host).toBe(true);
    }
  });

  it("case-folds the Host", () => {
    expect(isAllowedRequest({ host: "LOCALHOST:5320", origin: undefined }, PORT)).toBe(true);
    expect(isAllowedRequest({ host: "[::1]:5320", origin: "HTTP://LOCALHOST:5173" }, PORT)).toBe(true);
  });

  it("refuses a foreign Host (DNS rebinding) and a missing one", () => {
    expect(isAllowedRequest({ host: "evil.example:5320", origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ host: undefined, origin: undefined }, PORT)).toBe(false);
  });

  it("refuses a loopback Host on the wrong port, or with none", () => {
    expect(isAllowedRequest({ host: "127.0.0.1:5321", origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ host: "127.0.0.1", origin: undefined }, PORT)).toBe(false);
  });

  it("refuses a foreign Origin whatever the method: GET opens the SSE stream", () => {
    // The guard takes no method at all, so a GET is judged exactly like a POST.
    expect(isAllowedRequest({ host: "127.0.0.1:5320", origin: "https://evil.example" }, PORT)).toBe(false);
    expect(isAllowedRequest({ host: "127.0.0.1:5320", origin: "http://127.0.0.1.evil.example:80" }, PORT)).toBe(false);
    expect(isAllowedRequest({ host: "127.0.0.1:5320", origin: "null" }, PORT)).toBe(false);
  });

  it("allows a local Origin on any port", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:1", "http://[::1]:5320"]) {
      expect(isAllowedRequest({ host: "127.0.0.1:5320", origin }, PORT), origin).toBe(true);
    }
  });
});
