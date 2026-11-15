import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  checkoutProblem,
  defaultHerdrSocket,
  isPrivateHttpHost,
  MAX_TOKEN_FILE_BYTES,
  MAX_TOKEN_LENGTH,
  parseOrigin,
  parseRelayArgs,
  parseTokenText,
  readTokenFile,
  RELAY_KINDS,
  TokenFileError,
  tokenFileProblem,
} from "./relay-lib.mjs";

const tempDirs = [];
function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-lib-test-")));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME = "/Users/me";
const BASE = ["--url", "https://jetson.tail1234.ts.net", "--token-file", "/Users/me/.config/breakdown/relay-token", "--name", "relay-laptop", "--project", "bd=/Users/me/dev/bd"];
const parse = (argv) => parseRelayArgs(argv, { homedir: HOME });

describe("parseRelayArgs", () => {
  it("takes the origin, an absolute token file, a name, and repeatable key=path projects; defaults the rest", () => {
    assert.deepEqual(parse([...BASE, "--project", "e2e-relay=/Users/me/Library/Caches/e2e", "--project", "bd=/Users/me/dev/bd"]), {
      origin: "https://jetson.tail1234.ts.net",
      tokenFile: "/Users/me/.config/breakdown/relay-token",
      name: "relay-laptop",
      projects: [
        { key: "bd", path: "/Users/me/dev/bd" },
        { key: "e2e-relay", path: "/Users/me/Library/Caches/e2e" },
      ],
      kinds: RELAY_KINDS,
      herdrSockets: [defaultHerdrSocket(HOME)],
      maxAgeMs: 24 * 3_600_000,
    });
    assert.equal(defaultHerdrSocket(HOME), "/Users/me/.config/herdr/herdr.sock");
  });

  it("takes --kinds, repeatable --herdr-socket, and --max-age", () => {
    const parsed = parse([...BASE, "--kinds", "review_decision,beads_reingest", "--herdr-socket", "/tmp/a.sock", "--herdr-socket", "/tmp/b.sock", "--max-age", "90m"]);
    assert.deepEqual(parsed.kinds, ["review_decision", "beads_reingest"]);
    assert.deepEqual(parsed.herdrSockets, ["/tmp/a.sock", "/tmp/b.sock"]);
    assert.equal(parsed.maxAgeMs, 90 * 60_000);
    assert.equal(parse([...BASE, "--max-age", "2d"]).maxAgeMs, 2 * 86_400_000);
  });

  it("keeps the port and drops a bare trailing slash", () => {
    assert.equal(parse(["--url", "http://127.0.0.1:4310/", ...BASE.slice(2)]).origin, "http://127.0.0.1:4310");
  });

  it("requires --url, --token-file, --name, and at least one --project", () => {
    for (const flag of ["--url", "--token-file", "--name"]) {
      const at = BASE.indexOf(flag);
      const argv = [...BASE.slice(0, at), ...BASE.slice(at + 2)];
      assert.deepEqual(parse(argv), { error: `${flag} is required` });
    }
    assert.match(parse(BASE.slice(0, 6)).error, /--project <key>=<absolute path> is required/);
  });

  it("refuses a relative token file, a bad name, bad projects, kinds, sockets, ages, and unknown flags", () => {
    assert.match(parse([...BASE.slice(0, 2), "--token-file", "relay-token", ...BASE.slice(4)]).error, /--token-file must be an absolute path/);
    assert.match(parse([...BASE.slice(0, 4), "--name", "has space", ...BASE.slice(6)]).error, /--name must be a client name/);
    assert.match(parse([...BASE, "--project", "bd"]).error, /--project must be <key>=<absolute path>/);
    assert.match(parse([...BASE, "--project", "Bad Key=/x"]).error, /key must match/);
    assert.match(parse([...BASE, "--project", "x=dev/x"]).error, /must be absolute/);
    assert.match(parse([...BASE, "--project", "x=/Users/me/dev/x/"]).error, /real path/);
    assert.match(parse([...BASE, "--project", "x=/Users/me/../me/dev/x"]).error, /real path/);
    assert.match(parse([...BASE, "--project", "bd=/Users/me/dev/other"]).error, /given twice with different paths/);
    assert.match(parse([...BASE, "--kinds", "review_decision,bd_delete"]).error, /--kinds must list kinds/);
    assert.match(parse([...BASE, "--herdr-socket", "herdr.sock"]).error, /--herdr-socket must be an absolute path/);
    assert.match(parse([...BASE, "--max-age", "1w"]).error, /--max-age must be/);
    assert.match(parse([...BASE, "--max-age", "0h"]).error, /--max-age must be/);
    assert.match(parse([...BASE, "--token", "x"]).error, /Unknown option/);
    assert.match(parse([...BASE, "extra"]).error, /positional/i);
  });

  it("answers help", () => {
    assert.deepEqual(parseRelayArgs(["--help"]), { help: true });
  });
});

describe("parseOrigin", () => {
  it("takes https anywhere, and http only to loopback, a tailnet address, or a *.ts.net name", () => {
    for (const ok of ["https://example.com", "https://203.0.113.5:4310", "http://127.0.0.1:4310", "http://127.9.9.9", "http://localhost:4310", "http://[::1]:4310", "http://100.64.0.1", "http://100.127.255.254:4310", "http://jetson.tail1234.ts.net:4310"]) {
      assert.ok("origin" in parseOrigin(ok), ok);
    }
    for (const bad of ["http://example.com", "http://192.168.1.10:4310", "http://100.63.255.255", "http://100.128.0.1", "http://10.0.0.1", "http://ts.net", "http://evil.ts.net.example.com", "http://jetson.local"]) {
      assert.match(parseOrigin(bad).error, /plain http .* Use https/, bad);
    }
    assert.equal(isPrivateHttpHost("JETSON.TAIL1.TS.NET"), true);
  });

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

  it("refuses a symlink to a good file without following it (O_NOFOLLOW)", () => {
    const dir = tempDir();
    const real = path.join(dir, "real");
    fs.writeFileSync(real, "bdt_x\n", { mode: 0o600 });
    const link = path.join(dir, "relay-token");
    fs.symlinkSync(real, link);
    assert.throws(() => readTokenFile(link), /is a symlink/);
  });

  it("refuses a directory and a FIFO from the open descriptor, without hanging on the FIFO", () => {
    const dir = tempDir();
    const sub = path.join(dir, "token-dir");
    fs.mkdirSync(sub, { mode: 0o700 });
    assert.throws(() => readTokenFile(sub), /not a regular file|EISDIR/);
    const fifo = path.join(dir, "token-fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    assert.throws(() => readTokenFile(fifo), /not a regular file/);
  });

  it("refuses a file over the size cap before reading it", () => {
    const file = path.join(tempDir(), "relay-token");
    fs.writeFileSync(file, "x".repeat(MAX_TOKEN_FILE_BYTES + 1), { mode: 0o600 });
    assert.throws(() => readTokenFile(file), new RegExp(`holds ${MAX_TOKEN_FILE_BYTES + 1} bytes`));
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

describe("checkoutProblem", () => {
  it("keeps a real directory holding .beads/, and refuses a symlinked path, a missing one, and one without .beads/", () => {
    const dir = tempDir();
    const good = path.join(dir, "good");
    fs.mkdirSync(path.join(good, ".beads"), { recursive: true });
    assert.equal(checkoutProblem(good), null);
    const link = path.join(dir, "link");
    fs.symlinkSync(good, link);
    assert.match(checkoutProblem(link), /^resolves to /);
    assert.equal(checkoutProblem(path.join(dir, "missing")), "does not exist on this machine");
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    assert.equal(checkoutProblem(plain), "has no .beads/ directory");
    const linkedBeads = path.join(dir, "linked-beads");
    fs.mkdirSync(linkedBeads);
    fs.symlinkSync(path.join(good, ".beads"), path.join(linkedBeads, ".beads"));
    assert.equal(checkoutProblem(linkedBeads), "has no .beads/ directory");
  });
});
