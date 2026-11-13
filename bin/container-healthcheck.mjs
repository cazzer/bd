#!/usr/bin/env node
// The image's HEALTHCHECK: GET /healthz on both servers over loopback, which
// admission trusts without a token. Exits 0 only when both answer 200. It
// reads the ports the same way the launcher does, so a moved port moves
// the check with it. Assumes the servers listen on loopback, as they do on
// the default bind (0.0.0.0).
import { readPorts } from "./container-launch-lib.mjs";

const TIMEOUT_MS = 4_000;

async function probe(name, port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 200) return true;
    console.error(`[healthcheck] ${name} on ${port}: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`[healthcheck] ${name} on ${port}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

let ports;
try {
  ports = readPorts(process.env);
} catch (err) {
  console.error(`[healthcheck] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const results = await Promise.all([probe("web", ports.web), probe("mcp", ports.mcp)]);
process.exit(results.every(Boolean) ? 0 : 1);
