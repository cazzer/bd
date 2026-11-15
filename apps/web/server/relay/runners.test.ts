import { describe, expect, it, vi } from "vitest";
import { createRelayRunners, RelayRefusedError } from "./runners.js";

const DIR = "/Users/me/dev/bd";
const registry = { get: (project: string) => (project === "bd" ? { project, dir: DIR } : undefined) };

function runners(isSocket: (file: string) => boolean = () => true) {
  const bd = vi.fn(async () => "ok");
  const herdr = vi.fn(async () => {});
  const ingestBd = vi.fn(async () => "[]");
  return { bd, herdr, ingestBd, r: createRelayRunners({ registry, bd, herdr, ingestBd, isSocket }) };
}

describe("relay runners", () => {
  it("run every allowlisted bd shape in the project's checkout", async () => {
    const { bd, ingestBd, r } = runners();
    const run = r.bdFor("bd");
    for (const args of [
      ["show", "bd-x1", "--json"],
      ["comments", "add", "bd-x1", "Accepted."],
      ["update", "bd-x1", "--add-label", "review:changes"],
      ["update", "bd-x1", "--remove-label", "review:changes"],
      ["close", "bd-x1", "--reason", "Review accepted"],
    ]) {
      await run(args, DIR);
    }
    expect(bd).toHaveBeenCalledTimes(5);
    await r.ingestBdFor("bd")(["list", "--status=all", "--limit=0", "--json"], DIR);
    await r.ingestBdFor("bd")(["comments", "bd-x1", "--json"], DIR);
    expect(ingestBd).toHaveBeenCalledTimes(2);
  });

  it("refuse anything else before spawning, never quoting free text", async () => {
    const { bd, ingestBd, r } = runners();
    const refused: string[][] = [
      ["delete", "bd-x1"],
      ["close", "bd-x1", "--reason", "--force"],
      ["comments", "add", "bd-x1", "x".repeat(4001)],
      ["update", "bd-x1", "--add-label", "admin"],
      ["show", "--all", "--json"],
      ["list", "--json"],
    ];
    for (const args of refused) {
      await expect(r.bdFor("bd")(args, DIR)).rejects.toThrow(RelayRefusedError);
      await expect(r.ingestBdFor("bd")(args, DIR)).rejects.toThrow(/is not on the relay's allowlist/);
    }
    await expect(r.bdFor("bd")(["comments", "add", "bd-x1", "secret\u0000text"], DIR)).rejects.toThrow("bd comments with 4 arguments is not on the relay's allowlist");
    expect(bd).not.toHaveBeenCalled();
    expect(ingestBd).not.toHaveBeenCalled();
  });

  it("refuse a cwd other than the project's checkout, and a project not in the registry", async () => {
    const { bd, r } = runners();
    await expect(r.bdFor("bd")(["show", "bd-x1", "--json"], "/Users/me/dev/other")).rejects.toThrow("/Users/me/dev/other is not project bd's checkout in this relay's registry (/Users/me/dev/bd)");
    await expect(r.bdFor("bd")(["show", "bd-x1", "--json"], `${DIR}/`)).rejects.toThrow(RelayRefusedError);
    await expect(r.bdFor("other")(["show", "bd-x1", "--json"], DIR)).rejects.toThrow("project other is not in this relay's registry");
    expect(bd).not.toHaveBeenCalled();
  });

  it("run herdr only as agent prompt on a socket that is on disk", async () => {
    const onDisk = new Set(["/tmp/herdr.sock"]);
    const { herdr, r } = runners((file) => onDisk.has(file));
    await r.runHerdr(["agent", "prompt", "w1:p1", "Review bd-x1 accepted."], "/tmp/herdr.sock");
    expect(herdr).toHaveBeenCalledTimes(1);
    await expect(r.runHerdr(["agent", "send", "w1:p1", "x"], "/tmp/herdr.sock")).rejects.toThrow(/not on the relay's allowlist/);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "-x"], "/tmp/herdr.sock")).rejects.toThrow(/not on the relay's allowlist/);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "relative.sock")).rejects.toThrow(/not an absolute path/);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "/tmp/other.sock")).rejects.toThrow("the herdr socket /tmp/other.sock is not a socket on this machine");
    expect(herdr).toHaveBeenCalledTimes(1);
  });
});
