// Vite dev-proxies the tRPC path to the local server (bd-hmd.3) — the
// browser only ever talks to this dev server's own origin; it never opens
// a second one. `server.host` is left at its default (localhost), not
// `true`/`0.0.0.0`: the client dev server should be as loopback-only as
// the tRPC server it proxies to (the ticket's "not reachable from another
// host on the network" applies to the whole local tool, not just the API).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Must match server/index.ts's own default — see that file. */
const DEFAULT_SERVER_PORT = 4310;

const serverPort = Number(process.env["WEB_SERVER_PORT"] ?? DEFAULT_SERVER_PORT);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Pinned off Vite's 5173, which other projects' dev servers take first;
    // bin/review-request links to this port. strictPort fails loudly rather
    // than drifting. A second client passes `--port <n> --strictPort` to override.
    port: 5310,
    strictPort: true,
    proxy: {
      "/trpc": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },
      // Review screenshots (board-visual-reviews, design.md decision 4), served by the same server.
      "/review-images": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
});
