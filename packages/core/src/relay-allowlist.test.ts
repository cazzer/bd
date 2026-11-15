// relay-allowlist.ts (laptop-relay spec: "Only allowlisted commands run").
// Pure: every allowed shape, and the near misses a forged action would try.

import { describe, expect, it } from "vitest";
import { isAllowedBdArgs, isAllowedHerdrArgs, MAX_RELAY_BD_TEXT_LENGTH, MAX_RELAY_HERDR_TEXT_LENGTH } from "./relay-allowlist.js";

const ID = "bd-d38.11";

describe("isAllowedBdArgs", () => {
  it.each([
    [["show", ID, "--json"]],
    [["comments", "add", ID, "Accepted: B — ship it"]],
    [["update", ID, "--add-label", "review:changes"]],
    [["update", ID, "--remove-label", "review:changes"]],
    [["close", ID, "--reason", "Accepted option B"]],
    [["list", "--status=all", "--limit=0", "--json"]],
    [["comments", ID, "--json"]],
    [["show", "breakdown-a1b2", "--json"]],
    [["comments", "add", ID, "x".repeat(MAX_RELAY_BD_TEXT_LENGTH)]],
    [["comments", "add", ID, "line one\nline two -f"]],
  ])("accepts %j", (args) => {
    expect(isAllowedBdArgs(args)).toBe(true);
  });

  it.each([
    ["a text that would read as a flag", ["comments", "add", ID, "-f"]],
    ["a close reason that would read as a flag", ["close", ID, "--reason", "--force"]],
    ["bd delete", ["delete", ID]],
    ["bd delete with --force", ["delete", ID, "--force"]],
    ["a --db override", ["show", ID, "--json", "--db", "/tmp/other.db"]],
    ["--db in place of --json", ["show", ID, "--db"]],
    ["an extra argument", ["update", ID, "--add-label", "review:changes", "--json"]],
    ["a missing argument", ["comments", "add", ID]],
    ["a missing id", ["show", "--json"]],
    ["no arguments", []],
    ["another label", ["update", ID, "--add-label", "review"]],
    ["another update flag", ["update", ID, "--status", "closed"]],
    ["a list with other flags", ["list", "--status=open", "--limit=0", "--json"]],
    ["a NUL in the text", ["comments", "add", ID, "ok\u0000rm"]],
    ["an empty text", ["comments", "add", ID, ""]],
    ["an over-long text", ["comments", "add", ID, "x".repeat(MAX_RELAY_BD_TEXT_LENGTH + 1)]],
    ["an uppercase id", ["show", "BD-D38", "--json"]],
    ["an id that is a flag", ["show", "--all", "--json"]],
    ["an id with a path", ["show", "bd-../../etc", "--json"]],
    ["an id with no suffix", ["show", "bd", "--json"]],
    ["an over-long id", ["show", `bd-${"a".repeat(200)}`, "--json"]],
    ["a number in place of a string", ["show", 42, "--json"]],
    ["a nested array", [["show"], ID, "--json"]],
  ])("refuses %s", (_label, args) => {
    expect(isAllowedBdArgs(args)).toBe(false);
  });

  it("refuses anything that is not an array", () => {
    expect(isAllowedBdArgs("show bd-1 --json")).toBe(false);
    expect(isAllowedBdArgs(null)).toBe(false);
    expect(isAllowedBdArgs({ 0: "show", 1: ID, 2: "--json", length: 3 })).toBe(false);
  });
});

describe("isAllowedHerdrArgs", () => {
  it.each([
    [["agent", "prompt", "w1:p2", "Your review was accepted"]],
    [["agent", "prompt", "pane_3", "x".repeat(MAX_RELAY_HERDR_TEXT_LENGTH)]],
  ])("accepts %j", (args) => {
    expect(isAllowedHerdrArgs(args)).toBe(true);
  });

  it.each([
    ["a text that would read as a flag", ["agent", "prompt", "w1:p2", "--socket=/tmp/x"]],
    ["another subcommand", ["agent", "kill", "w1:p2", "bye"]],
    ["a session command", ["session", "open", "w1:p2", "hi"]],
    ["a pane that is a flag", ["agent", "prompt", "-p", "hi"]],
    ["a pane with a slash", ["agent", "prompt", "w1/p2", "hi"]],
    ["an over-long pane", ["agent", "prompt", "p".repeat(65), "hi"]],
    ["a NUL in the text", ["agent", "prompt", "w1:p2", "hi\u0000"]],
    ["an empty text", ["agent", "prompt", "w1:p2", ""]],
    ["an over-long text", ["agent", "prompt", "w1:p2", "x".repeat(MAX_RELAY_HERDR_TEXT_LENGTH + 1)]],
    ["an extra argument", ["agent", "prompt", "w1:p2", "hi", "--json"]],
    ["a missing text", ["agent", "prompt", "w1:p2"]],
    ["a non-string text", ["agent", "prompt", "w1:p2", 7]],
  ])("refuses %s", (_label, args) => {
    expect(isAllowedHerdrArgs(args)).toBe(false);
  });
});
