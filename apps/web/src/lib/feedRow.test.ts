// Tests for lib/feedRow.ts (node-views, tasks.md 3.2): node-views/spec.md's
// "Work items with links" (status/priority/assignee shown, a `url` value is
// a link keyed by name) and "A row without work-item fields" (absent
// fields are simply not shown) scenarios, plus the edges of the loose
// read — numbers, empty strings, non-http strings, a non-object metadata.

import { describe, expect, it } from "vitest";
import { extractLinks, pickRowFields } from "./feedRow.js";

describe("pickRowFields", () => {
  it("returns the three work-item fields as text when they are strings or numbers", () => {
    expect(pickRowFields({ status: "open", priority: 2, assignee: "caleb@cazzer.io" })).toEqual({ status: "open", priority: "2", assignee: "caleb@cazzer.io" });
  });

  it("answers null for a field that is absent — a row without work-item fields shows none", () => {
    expect(pickRowFields({ path: "docs/readme.md" })).toEqual({ status: null, priority: null, assignee: null });
    expect(pickRowFields({})).toEqual({ status: null, priority: null, assignee: null });
  });

  it("answers null for a field whose value is not a string or number (boolean, null, object, array)", () => {
    expect(pickRowFields({ status: true, priority: null, assignee: { name: "x" } })).toEqual({ status: null, priority: null, assignee: null });
    expect(pickRowFields({ status: ["open"] }).status).toBeNull();
  });

  it("treats an empty or whitespace-only string as absent, and trims the rest", () => {
    expect(pickRowFields({ status: "", assignee: "   " })).toEqual({ status: null, priority: null, assignee: null });
    expect(pickRowFields({ status: "  open " }).status).toBe("open");
  });

  it("treats NaN and infinities as absent, and keeps 0", () => {
    expect(pickRowFields({ priority: Number.NaN }).priority).toBeNull();
    expect(pickRowFields({ priority: Number.POSITIVE_INFINITY }).priority).toBeNull();
    expect(pickRowFields({ priority: 0 }).priority).toBe("0");
  });

  it("yields no fields for a non-object metadata (a hand-edited row)", () => {
    expect(pickRowFields(null)).toEqual({ status: null, priority: null, assignee: null });
    expect(pickRowFields("open")).toEqual({ status: null, priority: null, assignee: null });
    expect(pickRowFields(["open"])).toEqual({ status: null, priority: null, assignee: null });
  });
});

describe("extractLinks", () => {
  it("returns every top-level http(s) string value as a link keyed by its metadata key, in key order", () => {
    const links = extractLinks({ status: "open", url: "https://github.com/x/y/issues/1", pr_url: "http://example.test/pr/2", assignee: "a@b.c" });
    expect(links).toEqual([
      { key: "url", href: "https://github.com/x/y/issues/1" },
      { key: "pr_url", href: "http://example.test/pr/2" },
    ]);
  });

  it("ignores strings that are not http(s) URLs — a mailto, a bare host, a javascript: string, a path", () => {
    expect(extractLinks({ a: "mailto:a@b.c", b: "example.test", c: "javascript:alert(1)", d: "/docs/readme.md", e: "ftp://x" })).toEqual([]);
  });

  it("ignores non-string values and nested objects, even ones holding URLs", () => {
    expect(extractLinks({ links: ["https://x.test"], meta: { url: "https://x.test" }, n: 3, b: true, z: null })).toEqual([]);
  });

  it("accepts an upper-case scheme and trims surrounding whitespace", () => {
    expect(extractLinks({ url: "  HTTPS://x.test/a " })).toEqual([{ key: "url", href: "HTTPS://x.test/a" }]);
  });

  it("returns no links for an empty or non-object metadata", () => {
    expect(extractLinks({})).toEqual([]);
    expect(extractLinks(null)).toEqual([]);
    expect(extractLinks("https://x.test")).toEqual([]);
  });
});
