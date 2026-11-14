// The published contract stays in step with the server (hangar-queue spec,
// "The HTTP contract is published"): every endpoint heading in
// docs/hangar-api.md names an endpoint in `HANGAR_ENDPOINTS` with the same
// scope, and every endpoint has a heading. Adding or removing one in either
// place without the other fails here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HANGAR_ENDPOINTS } from "./hangar-api.js";

const DOC = fileURLToPath(new URL("../../../docs/hangar-api.md", import.meta.url));
const HEADING = /^### `(GET|POST|PATCH|PUT|DELETE) (\/hangar\/v1\/[^`]+)` — scope `([a-z]+)`/gm;

describe("docs/hangar-api.md", () => {
  it("documents exactly the endpoints the handler serves, each under its scope", () => {
    const documented = [...readFileSync(DOC, "utf8").matchAll(HEADING)].map(([, method, path, scope]) => `${method} ${path} ${scope}`);
    const served = HANGAR_ENDPOINTS.map((e) => `${e.method} ${e.path} ${e.scope}`);
    expect(new Set(documented).size, "a heading is repeated").toBe(documented.length);
    expect([...documented].sort()).toEqual([...served].sort());
  });
});
