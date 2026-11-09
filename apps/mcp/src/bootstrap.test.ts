// bootstrap() itself exits the process on failure and is covered end to end
// by startup.test.ts and stdio.test.ts. This file covers the one piece that
// matters after startup: a dead connection must not throw, or the server
// crashes. That covers both an idle client (the pool's 'error' event) and
// a checked-out one (the client's own 'error' event, mid-transaction).

import { createPool, resolveDatabaseUrl } from "@breakdown/db";
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

  it("a checked-out client without the logger throws on 'error' (pg-pool drops its idle listener on checkout)", async () => {
    const pool = createPool(resolveDatabaseUrl());
    const client = await pool.connect();
    try {
      expect(() => client.emit("error", new Error("terminating connection"))).toThrow("terminating connection");
    } finally {
      client.release(true);
      await pool.end();
    }
  });

  it("a checked-out client does not throw on 'error' once the logger is attached", async () => {
    const pool = createPool(resolveDatabaseUrl());
    attachPoolErrorLogger(pool);
    const client = await pool.connect();
    try {
      expect(() => client.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    } finally {
      client.release(true);
      await pool.end();
    }
  });
});
