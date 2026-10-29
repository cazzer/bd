import { describe, expect, it } from "vitest";
import { isAllowedRequest } from "./request-guard.js";

const PORT = 4310;

describe("isAllowedRequest", () => {
  it("allows the server's own loopback host, either spelling, any case", () => {
    expect(isAllowedRequest({ method: "GET", host: "127.0.0.1:4310", origin: undefined }, PORT)).toBe(true);
    expect(isAllowedRequest({ method: "GET", host: "localhost:4310", origin: undefined }, PORT)).toBe(true);
    expect(isAllowedRequest({ method: "POST", host: "LocalHost:4310", origin: undefined }, PORT)).toBe(true);
  });

  it("refuses a foreign Host, as a DNS-rebinding page would send", () => {
    expect(isAllowedRequest({ method: "GET", host: "evil.example:4310", origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ method: "POST", host: "evil.example:4310", origin: "http://evil.example:4310" }, PORT)).toBe(false);
  });

  it("refuses a missing Host, a host without the port, and another port", () => {
    expect(isAllowedRequest({ method: "GET", host: undefined, origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ method: "GET", host: "localhost", origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ method: "GET", host: "127.0.0.1:5173", origin: undefined }, PORT)).toBe(false);
    expect(isAllowedRequest({ method: "GET", host: "127.0.0.1:4310.evil.example", origin: undefined }, PORT)).toBe(false);
  });

  it("refuses a write from a foreign Origin even with a loopback Host", () => {
    for (const origin of ["https://evil.example", "http://evil.example:4310", "null", "http://localhost.evil.example:80", "https://localhost:5173", "http://127.0.0.1:4310/x"]) {
      expect(isAllowedRequest({ method: "POST", host: "127.0.0.1:4310", origin }, PORT)).toBe(false);
    }
  });

  it("allows the Vite-proxied write: Host rewritten to the target, Origin the dev client's", () => {
    expect(isAllowedRequest({ method: "POST", host: "127.0.0.1:4310", origin: "http://localhost:5310" }, PORT)).toBe(true);
    expect(isAllowedRequest({ method: "POST", host: "127.0.0.1:4310", origin: "http://127.0.0.1:5174" }, PORT)).toBe(true);
  });

  it("allows a write with no Origin (curl, the CLI) and does not check Origin on GET/HEAD", () => {
    expect(isAllowedRequest({ method: "POST", host: "localhost:4310", origin: undefined }, PORT)).toBe(true);
    expect(isAllowedRequest({ method: "GET", host: "localhost:4310", origin: "https://evil.example" }, PORT)).toBe(true);
    expect(isAllowedRequest({ method: "HEAD", host: "localhost:4310", origin: "https://evil.example" }, PORT)).toBe(true);
  });
});
