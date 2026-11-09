// Env parsing beyond DATABASE_URL (which @breakdown/db's
// resolveDatabaseUrl already owns). Nothing here reads the environment at
// module scope — parseReadOnly is a pure function of whatever string the
// caller (bootstrap.ts, at startup) hands it.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parses the optional BRAIN_READ_ONLY env var. Unset/anything not in the truthy set is `false`. */
export function parseReadOnly(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}
