import { describe, expect, test } from "vitest";
import { diagramKindName } from "./diagramKind.js";

describe("diagramKindName", () => {
  test("names the kind from the first keyword", () => {
    expect(diagramKindName("erDiagram\n  A ||--o{ B : has")).toBe("Entity-relationship diagram");
    expect(diagramKindName("graph TD; A-->B")).toBe("Flowchart");
    expect(diagramKindName("flowchart LR\n A --> B")).toBe("Flowchart");
    expect(diagramKindName("sequenceDiagram\n A->>B: hi")).toBe("Sequence diagram");
    expect(diagramKindName("stateDiagram-v2\n [*] --> A")).toBe("State diagram");
    expect(diagramKindName("xychart-beta\n x-axis [a]")).toBe("XY chart");
    expect(diagramKindName("C4Context\n title x")).toBe("C4 diagram");
  });

  test("skips frontmatter, %% comments and directives, and blank lines", () => {
    expect(diagramKindName("---\ntitle: Orders\n---\n\n%%{init: {\"theme\": \"dark\"}}%%\n%% a note\n  sequenceDiagram\n")).toBe("Sequence diagram");
  });

  test("anything unknown, empty, or only frontmatter is a Diagram", () => {
    expect(diagramKindName("zenumlDiagram")).toBe("Diagram");
    expect(diagramKindName("graphical")).toBe("Diagram");
    expect(diagramKindName("")).toBe("Diagram");
    expect(diagramKindName("---\ntitle: x\n")).toBe("Diagram");
  });
});
