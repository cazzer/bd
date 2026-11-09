// http-config.ts (brain-mcp spec, "Fail fast on misconfiguration" →
// "Invalid port"; "HTTP mode is local only" → "Non-loopback bind
// requested"; brain-service spec, "Portable server configuration" →
// "Defaults"). The process-level exit is covered by http.test.ts.

import { describe, expect, it } from "vitest";
import { HttpConfigError, parseHttpArgs } from "./http-config.js";

describe("parseHttpArgs", () => {
  it("defaults to 127.0.0.1:5320", () => {
    expect(parseHttpArgs([])).toEqual({ port: 5320, host: "127.0.0.1" });
  });

  it("accepts every loopback host, case folded", () => {
    expect(parseHttpArgs(["--host", "::1", "--port", "6000"])).toEqual({ port: 6000, host: "::1" });
    expect(parseHttpArgs(["--host", "LOCALHOST"])).toEqual({ port: 5320, host: "localhost" });
    expect(parseHttpArgs(["--port=65535"]).port).toBe(65535);
  });

  // `--port=<v>` so a value starting with "-" reaches the range check.
  it.each(["0", "70000", "abc", "80.5", "-1", ""])("refuses --port %j, naming the value", (value) => {
    expect(() => parseHttpArgs([`--port=${value}`])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs([`--port=${value}`])).toThrow(`--port "${value}" is not an integer from 1 to 65535`);
  });

  it.each(["0.0.0.0", "192.168.1.5", "::", "example.com"])("refuses non-loopback --host %s", (value) => {
    expect(() => parseHttpArgs(["--host", value])).toThrow(
      `--host ${value} is not a loopback address; network exposure is not supported in HTTP mode (use 127.0.0.1, ::1, or localhost)`,
    );
  });

  it("refuses an unknown flag and a positional argument", () => {
    expect(() => parseHttpArgs(["--bind", "127.0.0.1"])).toThrow(HttpConfigError);
    expect(() => parseHttpArgs(["--bind", "127.0.0.1"])).toThrow(/--bind/);
    expect(() => parseHttpArgs(["--", "--port", "1"])).toThrow(HttpConfigError);
  });
});
