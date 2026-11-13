import { describe, expect, it } from "vitest";
import { bindWarning, parseWebArgs, WebArgsError } from "./http-args.js";

describe("parseWebArgs", () => {
  it("defaults to loopback, port 4310, and no allowed hosts", () => {
    expect(parseWebArgs([], undefined)).toEqual({ host: "127.0.0.1", port: 4310, allowedHosts: [] });
  });

  it("takes WEB_SERVER_PORT when --port is absent, and --port over it when present", () => {
    expect(parseWebArgs([], "4400").port).toBe(4400);
    expect(parseWebArgs(["--port", "4500"], "4400").port).toBe(4500);
    expect(parseWebArgs([], "").port).toBe(4310);
  });

  it("takes --host, lowercased", () => {
    expect(parseWebArgs(["--host", "0.0.0.0"], undefined).host).toBe("0.0.0.0");
    expect(parseWebArgs(["--host", "LocalHost"], undefined).host).toBe("localhost");
  });

  it("takes --allow-host repeatedly, normalized", () => {
    expect(parseWebArgs(["--allow-host", "Breakdown.Tail.Example", "--allow-host", "100.64.0.7", "--allow-host", "[FD7A::1]"], undefined).allowedHosts).toEqual([
      "breakdown.tail.example",
      "100.64.0.7",
      "[fd7a::1]",
    ]);
  });

  it("refuses a bad port from either source, naming the value and its source", () => {
    for (const [argv, env, pattern] of [
      [["--port", "http"], undefined, /--port "http"/],
      [["--port", "70000"], undefined, /--port "70000"/],
      [["--port=-1"], undefined, /--port "-1"/],
      [[], "abc", /WEB_SERVER_PORT "abc"/],
    ] as const) {
      expect(() => parseWebArgs(argv, env)).toThrow(WebArgsError);
      expect(() => parseWebArgs(argv, env)).toThrow(pattern);
    }
  });

  it("refuses a bad --allow-host or an empty --host, naming the value", () => {
    for (const value of ["breakdown.tail.example:4310", "http://breakdown.tail.example", "*.tail.example", ""]) {
      expect(() => parseWebArgs(["--allow-host", value], undefined)).toThrow(WebArgsError);
      expect(() => parseWebArgs(["--allow-host", value], undefined)).toThrow(/--allow-host/);
    }
    expect(() => parseWebArgs(["--host", "  "], undefined)).toThrow(/--host "  " is empty/);
  });

  it("refuses an unknown flag or a positional, saying what is accepted", () => {
    expect(() => parseWebArgs(["--bind", "0.0.0.0"], undefined)).toThrow(/accepted: --port/);
    expect(() => parseWebArgs(["serve"], undefined)).toThrow(WebArgsError);
  });
});

describe("bindWarning", () => {
  it("is silent on a loopback bind", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(bindWarning({ host, port: 4310, allowedHosts: [] })).toBeNull();
    }
  });

  it("is silent off loopback once a host is allowed", () => {
    expect(bindWarning({ host: "0.0.0.0", port: 4310, allowedHosts: ["breakdown.tail.example"] })).toBeNull();
  });

  it("warns off loopback with no allowed host, naming the bind and the fix", () => {
    const warning = bindWarning({ host: "0.0.0.0", port: 4310, allowedHosts: [] });
    expect(warning).toMatch(/bound to 0\.0\.0\.0 with no --allow-host/);
    expect(warning).toMatch(/403/);
    expect(warning).toMatch(/--allow-host <name>/);
  });
});
