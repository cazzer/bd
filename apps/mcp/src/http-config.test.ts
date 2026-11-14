// http-config.ts (brain-mcp spec, "Fail fast on misconfiguration" →
// "Invalid port"; "HTTP mode is local by default" → "Default bind";
// brain-service spec, "Portable server configuration" → "Defaults"). The
// process-level exit is covered by http.test.ts.

import { describe, expect, it } from "vitest";
import { bindWarning, HttpConfigError, parseHttpArgs } from "./http-config.js";

describe("parseHttpArgs", () => {
  it("defaults to 127.0.0.1:5320 with no allowed hosts", () => {
    expect(parseHttpArgs([])).toEqual({ port: 5320, host: "127.0.0.1", allowedHosts: [] });
  });

  it("accepts every loopback host, case folded", () => {
    expect(parseHttpArgs(["--host", "::1", "--port", "6000"])).toEqual({ port: 6000, host: "::1", allowedHosts: [] });
    expect(parseHttpArgs(["--host", "LOCALHOST"]).host).toBe("localhost");
    expect(parseHttpArgs(["--port=65535"]).port).toBe(65535);
  });

  it.each(["0.0.0.0", "100.64.1.2"])("accepts a non-loopback --host %s", (value) => {
    expect(parseHttpArgs(["--host", value]).host).toBe(value);
  });

  it("refuses an empty --host", () => {
    expect(() => parseHttpArgs(["--host="])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs(["--host="])).toThrow(/--host "" is empty/);
  });

  // `--port=<v>` so a value starting with "-" reaches the range check.
  it.each(["70000", "65536", "abc", "80.5", "-1", ""])("refuses --port %j, naming the value", (value) => {
    expect(() => parseHttpArgs([`--port=${value}`])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs([`--port=${value}`])).toThrow(`--port "${value}" is not an integer from 0 to 65535`);
  });

  it("accepts --port 0 for an ephemeral port", () => {
    expect(parseHttpArgs(["--port", "0"]).port).toBe(0);
  });

  it("collects a repeated --allow-host, normalized", () => {
    expect(parseHttpArgs(["--allow-host", "Breakdown.Tail.Example", "--allow-host", "100.64.1.2"]).allowedHosts).toEqual([
      "breakdown.tail.example",
      "100.64.1.2",
    ]);
  });

  it.each(["a:80", "http://a", ""])("refuses --allow-host %j, naming the value", (value) => {
    expect(() => parseHttpArgs([`--allow-host=${value}`])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs([`--allow-host=${value}`])).toThrow(`--allow-host: invalid allowed host ${JSON.stringify(value)}`);
  });

  it("refuses an unknown flag and a positional argument", () => {
    expect(() => parseHttpArgs(["--bind", "127.0.0.1"])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs(["--bind", "127.0.0.1"])).toThrow(/--bind/);
    expect(() => parseHttpArgs(["--", "--port", "1"])).toThrow(HttpConfigError);
  });
});

describe("bindWarning", () => {
  it.each(["127.0.0.1", "127.0.0.2", "::1", "localhost"])("is null for a loopback bind on %s", (host) => {
    expect(bindWarning({ port: 5320, host, allowedHosts: [] })).toBeNull();
  });

  it("is null off loopback once a host is allowed", () => {
    expect(bindWarning({ port: 5320, host: "0.0.0.0", allowedHosts: ["breakdown.tail.example"] })).toBeNull();
  });

  it.each(["0.0.0.0", "100.64.1.2", "::"])("warns off loopback (%s) with no allowed host that only loopback Host values pass", (host) => {
    const warning = bindWarning({ port: 5320, host, allowedHosts: [] });
    expect(warning).toContain(`bound to ${host} with no --allow-host`);
    expect(warning).toMatch(/only requests whose Host is a loopback name/);
    expect(warning).toContain("--allow-host <name>");
  });
});
