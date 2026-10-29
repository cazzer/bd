// Env parsing beyond DATABASE_URL and WEB_SERVER_PORT (board-visual-reviews,
// task group 3). A copy of apps/mcp/src/config.ts's `parseReadOnly`, not an
// import: the adapters share no code (startup.ts is the same kind of copy),
// so both read BRAIN_READ_ONLY with one meaning. Nothing here reads the
// environment at module scope — index.ts hands it the string at startup.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parses the optional BRAIN_READ_ONLY env var. Unset/anything not in the truthy set is `false`. */
export function parseReadOnly(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}
