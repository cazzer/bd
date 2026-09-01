import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/web/server (bd-hmd.3) isn't under a package's src/ — the ticket's
    // layout puts the tRPC server at apps/web/server/, sibling to the Vite
    // client's apps/web/src/. Added alongside the existing patterns rather
    // than replacing them so every other package's tests are unaffected.
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/server/**/*.test.ts"],
    passWithNoTests: true,
  },
});
