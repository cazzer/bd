// Keeps `mermaid` out of the main bundle (decision-card-reviews, design.md
// decision 3): it may be imported statically only by MermaidDiagram.tsx, and
// MermaidDiagram only through MermaidBlock's `import("./MermaidDiagram.js")`.
// One static import anywhere else would pull ~1 MB of diagram code into the
// entry chunk without any test failing, so this reads the sources for it.
// Type-only imports are erased and allowed; tests (which mock mermaid) are
// skipped.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Module specifiers of every static `import … from "x"`, `import "x"`, and `export … from "x"`, skipping `import type` / `export type`. */
function staticSpecifiers(code: string): string[] {
  const statement = /(?:^|[\n;])\s*(import|export)\s+(?!type\s)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
  return [...code.matchAll(statement)].map((m) => m[2]!);
}

test("mermaid and MermaidDiagram are never imported statically outside their one place", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file);
    for (const specifier of staticSpecifiers(readFileSync(file, "utf8"))) {
      const isMermaid = specifier === "mermaid" || specifier.startsWith("mermaid/");
      const isDiagram = /(?:^|\/)MermaidDiagram(?:\.js|\.tsx)?$/.test(specifier);
      if ((isMermaid && name !== join("components", "MermaidDiagram.tsx")) || isDiagram) offenders.push(`${name}: ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the scanner sees the imports it guards against", () => {
  expect(staticSpecifiers('import mermaid from "mermaid";\nimport { a } from "./MermaidDiagram.js";\nimport "mermaid/dist/x";\nexport { b } from \'./MermaidDiagram\';')).toEqual(["mermaid", "./MermaidDiagram.js", "mermaid/dist/x", "./MermaidDiagram"]);
  expect(staticSpecifiers('import type { MermaidConfig } from "mermaid";\nconst M = lazy(() => import("./MermaidDiagram.js"));')).toEqual([]);
  expect(staticSpecifiers(readFileSync(join(SRC, "components", "MermaidDiagram.tsx"), "utf8"))).toContain("mermaid");
});
