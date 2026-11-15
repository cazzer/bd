import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MAX_TOKEN_LENGTH, parseOrigin, parseRelayArgs, parseTokenText, readTokenFile, TokenFileError, tokenFileProblem } from "./relay-lib.mjs";

const tempDirs = [];
function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-lib-test-")));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = ["--url", "https://jetson.tail1234.ts.net", "--token-file", "/Users/me/.config/breakdown/relay-token", "--name", "relay-laptop"];

describe("parseRelayArgs", () => {
  it("takes the origin, an absolute token file, a name, and repeatable projects", () => {
    assert.deepEqual(parseRelayArgs([...BASE, "--project", "bd", "--project", "e2e-relay", "--project", "bd"]), {
      origin: "https://jetson.tail1234.ts.net",
      tokenFile: "/Users/me/.config/breakdown/relay-token",
      name: "relay-laptop",
      projects: ["bd", "e2e-relay"],
    });
  });

  it("keeps the port and drops a bare trailing slash", () => {
    assert.equal(parseRelayArgs(["--url", "http://127.0.0.1:4310/", ...BASE.slice(2)]).origin, "http://127.0.0.1:4310");
  });

  it("requires --url, --token-file, and --name", () => {
    for (const flag of ["--url", "--token-file", "--name"]) {
      const at = BASE.indexOf(flag);
      const argv = [...BASE.slice(0, at), ...BASE.slice(at + 2)];
      assert.deepEqual(parseRelayArgs(argv), { error: `${flag} is required` });
    }
  });

  it("refuses a relative token file, a bad name, a bad project key, and unknown flags", () => {
    assert.match(parseRelayArgs([...BASE.slice(0, 2), "--token-file", "relay-token", ...BASE.slice(4)]).error, /--token-file must be an absolute path/);
    assert.match(parseRelayArgs([...BASE.slice(0, 4), "--name", "has space"]).error, /--name must be a client name/);
    assert.match(parseRelayArgs([...BASE, "--project", "Bad Key"]).error, /--project must be a project key/);
    assert.match(parseRelayArgs([...BASE, "--token", "x"]).error, /Unknown option/);
    assert.match(parseRelayArgs([...BASE, "extra"]).error, /positional/i);
  });

  it("answers help", () => {
    assert.deepEqual(parseRelayArgs(["--help"]), { help: true });
  });
});

describe("parseOrigin", () => {
  it("refuses other schemes, credentials, paths, queries, and fragments", () => {
    assert.match(parseOrigin("ftp://host").error, /http or https/);
    assert.match(parseOrigin("https://u:p@host").error, /credentials/);
    assert.match(parseOrigin("https://host/relay/v1").error, /origin with no path/);
    assert.match(parseOrigin("https://host?x=1").error, /origin with no path/);
    assert.match(parseOrigin("https://host#x").error, /origin with no path/);
    assert.match(parseOrigin("not a url").error, /not a URL/);
  });
});

function fakeStat({ symlink = false, file = true, uid = 501, mode = 0o100600 } = {}) {
  return { isSymbolicLink: () => symlink, isFile: () => file, uid, mode };
}

describe("tokenFileProblem", () => {
  it("accepts a regular file of yours with no group or other bits", () => {
    assert.equal(tokenFileProblem("/t", fakeStat(), 501), null);
    assert.equal(tokenFileProblem("/t", fakeStat({ mode: 0o100400 }), 501), null);
  });

  it("refuses a symlink, a non-file, another owner, and any group or other bit, naming the octal mode and the chmod", () => {
    assert.match(tokenFileProblem("/t", fakeStat({ symlink: true }), 501), /is a symlink/);
    assert.match(tokenFileProblem("/t", fakeStat({ file: false }), 501), /not a regular file/);
    assert.match(tokenFileProblem("/t", fakeStat({ uid: 0 }), 501), /owned by uid 0, not by you \(uid 501\)/);
    assert.equal(tokenFileProblem("/t", fakeStat({ mode: 0o100644 }), 501), "/t has mode 0644, readable or writable by others; run: chmod 600 /t");
    assert.match(tokenFileProblem("/t", fakeStat({ mode: 0o100620 }), 501), /mode 0620/);
    assert.match(tokenFileProblem("/t", fakeStat({ mode: 0o100601 }), 501), /mode 0601/);
  });
});

describe("parseTokenText", () => {
  it("trims one line", () => {
    assert.deepEqual(parseTokenText("/t", "bdt_abc123\n"), { token: "bdt_abc123" });
  });

  it("refuses empty, over-long, and multi-line or spaced text without quoting it", () => {
    assert.match(parseTokenText("/t", " \n").error, /is empty/);
    assert.match(parseTokenText("/t", "x".repeat(MAX_TOKEN_LENGTH + 1)).error, /at most 512/);
    assert.equal(parseTokenText("/t", "x".repeat(MAX_TOKEN_LENGTH)).token.length, MAX_TOKEN_LENGTH);
    const twoLines = parseTokenText("/t", "bdt_secret1\nbdt_secret2\n").error;
    assert.match(twoLines, /one token on one line/);
    assert.doesNotMatch(twoLines, /secret/);
    assert.match(parseTokenText("/t", "bdt_a bdt_b").error, /one token on one line/);
  });
});

describe("readTokenFile", () => {
  it("reads a real 0600 file of yours", () => {
    const file = path.join(tempDir(), "relay-token");
    fs.writeFileSync(file, "bdt_realtoken\n", { mode: 0o600 });
    assert.equal(readTokenFile(file), "bdt_realtoken");
  });

  it("refuses a real 0644 file, naming the path and mode, never the token", () => {
    const file = path.join(tempDir(), "relay-token");
    fs.writeFileSync(file, "bdt_leakytoken\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.throws(
      () => readTokenFile(file),
      (err) => err instanceof TokenFileError && err.message.includes(file) && err.message.includes("0644") && err.message.includes(`chmod 600 ${file}`) && !err.message.includes("leaky"),
    );
  });

  it("refuses a symlink to a good file without following it", () => {
    const dir = tempDir();
    const real = path.join(dir, "real");
    fs.writeFileSync(real, "bdt_x\n", { mode: 0o600 });
    const link = path.join(dir, "relay-token");
    fs.symlinkSync(real, link);
    assert.throws(() => readTokenFile(link), /is a symlink/);
  });

  it("says a missing file does not exist", () => {
    assert.throws(() => readTokenFile(path.join(tempDir(), "nope")), /does not exist/);
  });

  it("refuses a file owned by another uid (injected)", () => {
    const file = path.join(tempDir(), "relay-token");
    fs.writeFileSync(file, "bdt_x\n", { mode: 0o600 });
    assert.throws(() => readTokenFile(file, { uid: (process.getuid?.() ?? 0) + 1 }), /owned by uid/);
  });
});
