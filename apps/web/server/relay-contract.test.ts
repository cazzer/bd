// The published contract stays in step with the server (laptop-relay
// decision 5, as hangar-contract.test.ts does for hangar): every endpoint heading in
// docs/relay.md names an endpoint in `RELAY_ENDPOINTS` with the same
// scope, and every endpoint has a heading. Adding or removing one in either
// place without the other fails here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claimSchema, RELAY_ENDPOINTS } from "./relay-api.js";

const DOC = fileURLToPath(new URL("../../../docs/relay.md", import.meta.url));
const HEADING = /^### `(GET|POST|PATCH|PUT|DELETE) (\/relay\/v1\/[^`]+)` — scope `([a-z]+)`/gm;

describe("docs/relay.md", () => {
  it("documents exactly the endpoints the handler serves, each under its scope", () => {
    const documented = [...readFileSync(DOC, "utf8").matchAll(HEADING)].map(([, method, path, scope]) => `${method} ${path} ${scope}`);
    const served = RELAY_ENDPOINTS.map((e) => `${e.method} ${e.path} ${e.scope}`);
    expect(new Set(documented).size, "a heading is repeated").toBe(documented.length);
    expect([...documented].sort()).toEqual([...served].sort());
  });

  it("documents every field a claim takes", () => {
    const doc = readFileSync(DOC, "utf8");
    const start = doc.indexOf("### `POST /relay/v1/claim`");
    const section = doc.slice(start, doc.indexOf("\n### ", start + 1));
    for (const field of Object.keys(claimSchema.shape)) expect(section, field).toContain(`- \`${field}\``);
  });
});
