// bootstrap() itself exits the process on failure and is covered end to end
// by startup.test.ts and stdio.test.ts. This file covers the one piece that
// matters after startup: a pool 'error' (an idle client's connection dying
// when Postgres stops) must be logged, not thrown, or the server crashes.

import { createPool } from "@breakdown/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPoolErrorLogger } from "./bootstrap.js";

describe("attachPoolErrorLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an unprepared pool throws on 'error', which is the crash the logger exists to prevent", async () => {
    const pool = createPool("postgres://breakdown:breakdown@127.0.0.1:1/breakdown");
    try {
      expect(() => pool.emit("error", new Error("terminating connection"))).toThrow("terminating connection");
    } finally {
      await pool.end();
    }
  });

  it("logs a lost connection to stderr and does not throw", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPool("postgres://breakdown:breakdown@127.0.0.1:1/breakdown");
    try {
      attachPoolErrorLogger(pool);
      expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toMatch(/^\[breakdown-brain\] database connection lost: terminating connection due to administrator command \(server keeps running/);
    } finally {
      await pool.end();
    }
  });
});
