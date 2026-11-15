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
    const linkedBeads = path.join(tmp, "linked-beads");
    mkdirSync(linkedBeads);
    symlinkSync(path.join(real, ".beads"), path.join(linkedBeads, ".beads"));
    expect(checkoutProblem(linkedBeads)).toBe("has no .beads/ directory");
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
  const local = [
    { project: "bd", dir: good },
    { project: "other", dir: other },
    { project: "gone", dir: path.join(tmp, "gone") },
  ];
  const answer = { projects: [{ key: "bd", path: good }, { key: "other", path: other }, { key: "gone", path: path.join(tmp, "gone") }], push: true };

  it("keeps the local projects the server lists at the same path that are checkouts here, with the push flag", async () => {
    const lines: string[] = [];
    const send = vi.fn(async () => answer);
    const registry = createRelayRegistry({ client: { send }, local, log: (l) => lines.push(l) });
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

  it("never adds a project the server lists that the relay was not given, and never takes the server's path", async () => {
    const lines: string[] = [];
    const elsewhere = checkout("elsewhere");
    const send = vi.fn(async () => ({
      projects: [
        { key: "bd", path: elsewhere },
        { key: "intruder", path: other },
        { key: "evil\n[relay] forged line", path: other },
      ],
      push: true,
    }));
    const registry = createRelayRegistry({ client: { send }, local: [{ project: "bd", dir: good }], log: (l) => lines.push(l) });
    await registry.refresh();
    expect(registry.entries()).toEqual([]);
    expect(registry.get("bd")).toBeUndefined();
    expect(registry.get("intruder")).toBeUndefined();
    expect(lines).toContain(`[relay] warning: the server lists project bd at ${JSON.stringify(elsewhere)}, not this relay's ${good}; ignoring the server's entry and not serving bd until they agree`);
    expect(lines.some((l) => l.startsWith("[relay] ignoring 2 project(s) the server lists") && l.includes("intruder"))).toBe(true);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);

    // Once the server agrees, the local path is served.
    send.mockResolvedValueOnce({ projects: [{ key: "bd", path: good }], push: false });
    expect(await registry.refresh()).toBe(true);
    expect(registry.entries()).toEqual([{ project: "bd", dir: good }]);
  });

  it("narrows to what the server lists: a local project it does not list is not served, and says so", async () => {
    const lines: string[] = [];
    const registry = createRelayRegistry({ client: { send: async () => ({ projects: [{ key: "bd", path: good }], push: true }) }, local: [{ project: "bd", dir: good }, { project: "other", dir: other }], log: (l) => lines.push(l) });
    await registry.refresh();
    expect(registry.entries()).toEqual([{ project: "bd", dir: good }]);
    expect(lines).toContain(`[relay] project other (${other}) is not registered on the server; not serving it until it is (register it with a local beads ingest)`);
  });

  it("throws on a malformed answer, keeping what it had", async () => {
    const send = vi.fn(async () => answer as unknown);
    const registry = createRelayRegistry({ client: { send }, local });
    await registry.refresh();
    send.mockResolvedValueOnce({ projects: "x" });
    await expect(registry.refresh()).rejects.toThrow(/without projects and push/);
    expect(registry.get("bd")).toEqual({ project: "bd", dir: good });
  });
});
