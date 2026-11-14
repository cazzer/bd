// Host-only binaries (tailnet-hosting design.md decision 8). `bd` and
// `herdr` live on the person's Mac, not in the container image. Every
// spawn of either maps ENOENT (with a usable cwd) to
// HostBinaryUnavailableError naming the binary, and the web server checks
// PATH once at startup with `findOnPath`, so a feature that needs one
// reports itself unavailable instead of failing the request some other way.

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type HostBinary = "bd" | "herdr";

/** A feature needed `binary` and this server has none on PATH. */
export class HostBinaryUnavailableError extends Error {
  readonly binary: HostBinary;

  constructor(binary: HostBinary) {
    super(`${binary} is unavailable on this server: not found on PATH`);
    this.name = "HostBinaryUnavailableError";
    this.binary = binary;
  }
}

/** The first executable regular file named `binary` on `pathEnv`, or null. Empty entries are skipped, not read as the cwd. */
export function findOnPath(binary: string, pathEnv: string | undefined = process.env["PATH"]): string | null {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}
