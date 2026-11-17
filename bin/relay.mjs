#!/usr/bin/env node
// The laptop relay (laptop-relay design.md decision 7; docs/relay.md). A
// thin runner: it parses the flags and checks the token file
// (relay-lib.mjs), then runs apps/web/server/relay/main.ts, which needs
// tsx and @breakdown/core, so run it as
//
//   cd apps/web && node --import tsx ../../bin/relay.mjs --url … --token-file … --name … --project key=/abs/path
//
// (what `pnpm relay …` and the launchd service do).

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRelayArgs, readTokenFile, RELAY_USAGE, TokenFileError } from "./relay-lib.mjs";

const parsed = parseRelayArgs(process.argv.slice(2));
if ("help" in parsed) {
  console.log(RELAY_USAGE);
  process.exit(0);
}
if ("error" in parsed) {
  console.error(`[relay] ${parsed.error}`);
  console.error(RELAY_USAGE);
  process.exit(2);
}
try {
  readTokenFile(parsed.tokenFile);
} catch (err) {
  console.error(`[relay] cannot start: ${err instanceof TokenFileError ? err.message : String(err)}`);
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let runRelay;
try {
  ({ runRelay } = await import(pathToFileURL(path.join(repoRoot, "apps", "web", "server", "relay", "main.ts")).href));
} catch (err) {
  console.error(`[relay] cannot start: could not load the relay (${err instanceof Error ? err.message : String(err)}); run it with \`node --import tsx\` from apps/web (pnpm relay)`);
  process.exit(1);
}

const code = await runRelay({
  origin: parsed.origin,
  name: parsed.name,
  projects: parsed.projects,
  kinds: parsed.kinds,
  herdrSockets: parsed.herdrSockets,
  maxAgeMs: parsed.maxAgeMs,
  mediaDir: parsed.mediaDir,
  readToken: () => readTokenFile(parsed.tokenFile),
});
process.exit(code);
