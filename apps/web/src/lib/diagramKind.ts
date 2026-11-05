// The kind of a mermaid diagram, named for a person — the drawn image's text
// alternative (decision-card-reviews, design.md decision 3). The caption
// belongs to the figure's <figcaption>; the image says what sort of picture
// it is, and the source is offered as text beside it.
//
// Read from the first keyword of the source, after any frontmatter block,
// `%%` comments and directives, and blank lines — the same place mermaid
// reads it from.

const KINDS: ReadonlyArray<[RegExp, string]> = [
  [/^erDiagram\b/, "Entity-relationship diagram"],
  [/^(?:flowchart|graph)\b/, "Flowchart"],
  [/^sequenceDiagram\b/, "Sequence diagram"],
  [/^classDiagram\b/, "Class diagram"],
  [/^stateDiagram\b/, "State diagram"],
  [/^gantt\b/, "Gantt chart"],
  [/^pie\b/, "Pie chart"],
  [/^journey\b/, "User journey diagram"],
  [/^gitGraph\b/, "Git graph"],
  [/^mindmap\b/, "Mind map"],
  [/^timeline\b/, "Timeline"],
  [/^quadrantChart\b/, "Quadrant chart"],
  [/^xychart\b/, "XY chart"],
  [/^sankey\b/, "Sankey diagram"],
  [/^requirementDiagram\b/, "Requirement diagram"],
  [/^C4\w*/, "C4 diagram"],
  [/^block\b/, "Block diagram"],
  [/^architecture\b/, "Architecture diagram"],
  [/^packet\b/, "Packet diagram"],
  [/^kanban\b/, "Kanban board"],
];

export function diagramKindName(source: string): string {
  const lines = source.split("\n").map((line) => line.trim());
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    i = end === -1 ? lines.length : end + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "" || line.startsWith("%%")) continue;
    return KINDS.find(([pattern]) => pattern.test(line))?.[1] ?? "Diagram";
  }
  return "Diagram";
}
