import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkoutProblem, createRelayRegistry } from "./registry.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "relay-registry-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string, beads = true): string {
  const dir = path.join(tmp, name);
  mkdirSync(beads ? path.join(dir, ".beads") : dir, { recursive: true });
  return dir;
}

describe("checkoutProblem", () => {
  it("keeps a real directory holding .beads/", () => {
    expect(checkoutProblem(checkout("good"))).toBeNull();
  });

  it("refuses a symlinked path, a missing one, a file, a checkout without .beads/, and a relative path", () => {
    const real = checkout("target");
    const link = path.join(tmp, "link");
    symlinkSync(real, link);
    expect(checkoutProblem(link)).toMatch(/^resolves to .*target/);
    expect(checkoutProblem(path.join(tmp, "missing"))).toBe("does not exist on this machine");
    const file = path.join(tmp, "file");
    writeFileSync(file, "");
    expect(checkoutProblem(file)).toBe("is not a directory");
    expect(checkoutProblem(checkout("plain", false))).toBe("has no .beads/ directory");
    expect(checkoutProblem("dev/bd")).toBe("is not an absolute path");
  });
});

describe("the relay registry", () => {
  const good = checkout("bd");
  const other = checkout("other");
  const answer = { projects: [{ key: "bd", path: good }, { key: "other", path: other }, { key: "gone", path: path.join(tmp, "gone") }], push: true };

  it("keeps the server's projects that are checkouts here, with the push flag", async () => {
    const lines: string[] = [];
    const send = vi.fn(async () => answer);
    const registry = createRelayRegistry({ client: { send }, log: (l) => lines.push(l) });
    expect(registry.loaded()).toBe(false);
    expect(await registry.refresh()).toBe(true);
    expect(send).toHaveBeenCalledWith("GET", "/relay/v1/projects", undefined, {});
    expect(registry.entries()).toEqual([
      { project: "bd", dir: good },
      { project: "other", dir: other },
    ]);
    expect(registry.get("gone")).toBeUndefined();
    expect(registry.push()).toBe(true);
    expect(lines.some((l) => l.startsWith("[relay] skipping project gone:"))).toBe(true);
    // An unchanged refresh says nothing new and reports no change.
    const said = lines.length;
    expect(await registry.refresh()).toBe(false);
    expect(lines.length).toBe(said);
  });

  it("narrows to --project keys and says when one is not registered", async () => {
    const lines: string[] = [];
    const registry = createRelayRegistry({ client: { send: async () => answer }, only: ["bd", "nope"], log: (l) => lines.push(l) });
    await registry.refresh();
    expect(registry.entries()).toEqual([{ project: "bd", dir: good }]);
    expect(lines).toContain("[relay] project nope (--project) is not registered on the server; register it with a local beads ingest");
  });

  it("throws on a malformed answer, keeping what it had", async () => {
    const send = vi.fn(async () => answer as unknown);
    const registry = createRelayRegistry({ client: { send } });
    await registry.refresh();
    send.mockResolvedValueOnce({ projects: "x" });
    await expect(registry.refresh()).rejects.toThrow(/without projects and push/);
    expect(registry.get("bd")).toEqual({ project: "bd", dir: good });
  });
});
