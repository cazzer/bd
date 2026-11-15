import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH, MAX_RELAY_HERDR_TEXT_LENGTH, RELAY_PROVENANCE_LINE, RELAY_PROVENANCE_SEPARATOR } from "@breakdown/core";
import { createRelayRunners, RelayRefusedError, type SocketInspection } from "./runners.js";

const DIR = "/Users/me/dev/bd";
const UID = 501;
const SOCKET = "/Users/me/.config/herdr/herdr.sock";
const registry = { get: (project: string) => (project === "bd" ? { project, dir: DIR } : undefined) };

function runners({ inspect = (_file: string): SocketInspection => ({ isSocket: true, uid: UID }), checkDir = (_dir: string): string | null => null, sockets = [SOCKET] } = {}) {
  const bd = vi.fn(async () => "ok");
  const herdr = vi.fn(async () => {});
  const ingestBd = vi.fn(async () => "[]");
  return { bd, herdr, ingestBd, r: createRelayRunners({ registry, herdrSockets: sockets, bd, herdr, ingestBd, inspectSocket: inspect, uid: UID, checkDir }) };
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

  it("re-check the checkout immediately before every spawn", async () => {
    let problem: string | null = null;
    const { bd, ingestBd, r } = runners({ checkDir: () => problem });
    await r.bdFor("bd")(["show", "bd-x1", "--json"], DIR);
    problem = "resolves to /tmp/elsewhere (a symlink or a non-canonical spelling); give the real path";
    await expect(r.bdFor("bd")(["show", "bd-x1", "--json"], DIR)).rejects.toThrow(`project bd's checkout ${DIR} resolves to /tmp/elsewhere`);
    await expect(r.ingestBdFor("bd")(["list", "--status=all", "--limit=0", "--json"], DIR)).rejects.toThrow(RelayRefusedError);
    expect(bd).toHaveBeenCalledTimes(1);
    expect(ingestBd).not.toHaveBeenCalled();
  });

  it("refuse a cwd other than the project's checkout, and a project not in the registry", async () => {
    const { bd, r } = runners();
    await expect(r.bdFor("bd")(["show", "bd-x1", "--json"], "/Users/me/dev/other")).rejects.toThrow("/Users/me/dev/other is not project bd's checkout in this relay's registry (/Users/me/dev/bd)");
    await expect(r.bdFor("bd")(["show", "bd-x1", "--json"], `${DIR}/`)).rejects.toThrow(RelayRefusedError);
    await expect(r.bdFor("other")(["show", "bd-x1", "--json"], DIR)).rejects.toThrow("project other is not in this relay's registry");
    expect(bd).not.toHaveBeenCalled();
  });

  it("run herdr only as agent prompt, with the provenance line first, on an allowlisted socket of this user", async () => {
    const { herdr, r } = runners();
    await r.runHerdr(["agent", "prompt", "w1:p1", "Review bd-x1 accepted."], SOCKET);
    expect(herdr).toHaveBeenCalledWith(["agent", "prompt", "w1:p1", `${RELAY_PROVENANCE_LINE}${RELAY_PROVENANCE_SEPARATOR}Review bd-x1 accepted.`], SOCKET);
    await expect(r.runHerdr(["agent", "send", "w1:p1", "x"], SOCKET)).rejects.toThrow(/not on the relay's allowlist/);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "-x"], SOCKET)).rejects.toThrow(/not on the relay's allowlist/);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "relative.sock")).rejects.toThrow(/not an absolute path/);
    expect(herdr).toHaveBeenCalledTimes(1);
  });

  it("keep the prompt as sent within the herdr cap", async () => {
    const { herdr, r } = runners();
    const fits = "x".repeat(MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH);
    await r.runHerdr(["agent", "prompt", "w1:p1", fits], SOCKET);
    expect((herdr.mock.calls[0] as unknown as string[][])[0]![3]).toHaveLength(MAX_RELAY_HERDR_TEXT_LENGTH);
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", `${fits}x`], SOCKET)).rejects.toThrow(/within the cap/);
    expect(herdr).toHaveBeenCalledTimes(1);
  });

  it("refuse a socket outside --herdr-socket, one not on disk, one that is not a socket, and one owned by another uid", async () => {
    const seen: Record<string, SocketInspection> = {
      [SOCKET]: { isSocket: true, uid: UID },
      "/tmp/missing.sock": null,
      "/tmp/file.sock": { isSocket: false, uid: UID },
      "/tmp/root.sock": { isSocket: true, uid: 0 },
    };
    const { herdr, r } = runners({ inspect: (f: string) => seen[f] ?? null, sockets: [SOCKET, "/tmp/missing.sock", "/tmp/file.sock", "/tmp/root.sock"] });
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "/tmp/other.sock")).rejects.toThrow("the herdr socket /tmp/other.sock is not one this relay may prompt through (--herdr-socket)");
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "/tmp/missing.sock")).rejects.toThrow("the herdr socket /tmp/missing.sock is not a socket on this machine");
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "/tmp/file.sock")).rejects.toThrow("is not a socket on this machine");
    await expect(r.runHerdr(["agent", "prompt", "w1:p1", "x"], "/tmp/root.sock")).rejects.toThrow("the herdr socket /tmp/root.sock is owned by uid 0, not by this relay's user");
    expect(herdr).not.toHaveBeenCalled();
  });

  it("by default lstat the socket: a real socket of this user passes, a symlink to it does not", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "relay-runners-")));
    const real = path.join(dir, "herdr.sock");
    const link = path.join(dir, "link.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(real, resolve));
    symlinkSync(real, link);
    try {
      const herdr = vi.fn(async () => {});
      const r = createRelayRunners({ registry, herdrSockets: [real, link], herdr, bd: vi.fn(), ingestBd: vi.fn() });
      await r.runHerdr(["agent", "prompt", "w1:p1", "hi"], real);
      await expect(r.runHerdr(["agent", "prompt", "w1:p1", "hi"], link)).rejects.toThrow(`the herdr socket ${link} is not a socket on this machine`);
      expect(herdr).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
