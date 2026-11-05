---
question: "Move the default-view picker from the toolbar into the node header?"
on_accept:
  - "Move the picker into the node header and remove the toolbar control."
attachments:
  - kind: image
    path: before.png
    caption: "Picker in the toolbar today"
    pair: before
  - kind: image
    path: after.png
    caption: "Picker in the node header"
    pair: after
  - kind: mermaid
    caption: "What the picker writes: a default_view edge to a view node"
    source: |-
      erDiagram
        NODE ||--o{ EDGE : "source of"
        VIEW ||--o{ EDGE : "target of"
        NODE {
          uuid id
          text node_type
          text title
        }
        EDGE {
          uuid source_id
          uuid target_id
          text relation "default_view"
          real weight
        }
        VIEW {
          uuid id
          text renderer
          jsonb filter
        }
---
The picker writes the same `default_view` edge from either place; only where it sits changes. In the header it is next to the title it governs, and the toolbar loses a control that did nothing for nodes without children.
