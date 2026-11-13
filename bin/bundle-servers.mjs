#!/usr/bin/env node
// `pnpm bundle [--outdir <dir>]` (tailnet-hosting decision 6): bundles each
// server entrypoint, with every dependency, into one ESM file under the
// outdir (default `dist/` at the repo root), so the container image ships
// those files and no node_modules.
//
// pg is bundled; its optional native binding stays external and is never
// loaded. Some CommonJS dependencies call `require` for Node built-ins, which
// ESM output has no binding for, so the banner provides one.
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entryPoints = {
  web: "apps/web/server/index.ts",
  mcp: "apps/mcp/src/http.ts",
  migrate: "packages/db/src/migrate.ts",
  token: "packages/core/src/cli/token.ts",
};

const { values } = parseArgs({ options: { outdir: { type: "string" } } });
const outdir = path.resolve(values.outdir ?? path.join(repoRoot, "dist"));

await build({
  absWorkingDir: repoRoot,
  entryPoints: Object.fromEntries(Object.entries(entryPoints).map(([name, file]) => [name, path.join(repoRoot, file)])),
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outExtension: { ".js": ".mjs" },
  external: ["pg-native"],
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __bdCreateRequire } from "node:module"; const require = __bdCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});

console.error(`[bundle] ${Object.keys(entryPoints).map((name) => `${name}.mjs`).join(", ")} → ${outdir}`);
