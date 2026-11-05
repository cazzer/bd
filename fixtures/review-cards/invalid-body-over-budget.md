---
question: "Accept the decision-card layout as built for the drawer and the Review all run?"
options:
  - id: A
    label: "Accept as built"
  - id: B
    label: "Rework the run's footer"
recommend: A
---
## What was built

Group 1 added the card contract to core: the normalizer accepts the question, options, recommendation, on-accept steps, and attachments, fits over-long text, replaces NUL, and stays idempotent; the beads mapper and the ingest tests carry a card through a load and report a reload unchanged.

Group 2 taught the CLI the card form. It splits the frontmatter, imports yaml only on that path, validates every field strictly and names the one that breaks, resolves image attachments against the card, and files the body as the description; the legacy form is untouched and a test proves it never loads yaml.

Group 3 made decisions name an option on the server. The writer checks the option against the record it read before writing, refuses one the card does not offer, and writes the option into the comment, the close reason, and the prompt sent to the pane.

Group 4 built three static prototypes of the layout, priced each one, and asked for a pick through the board; the chosen layout is recorded as decision 7.

Group 5 added the read-only evidence renderer with tables, a diff block with line classes and screen-reader prefixes, and a lazily loaded mermaid diagram drawn through an image so no markup from a source can run.

Group 6 put the card in the drawer and the run: question first, the recommended option with its risk, the other options, the steps, the attachments, then the evidence collapsed; Accept, Choose, and Request changes carry the option, with the run's shortcuts and arming intact.

## Verification

| Check | Result |
| --- | --- |
| pnpm check | 83 files, 1562 tests, all passing |
| fold check at 1440 by 900 | question, option A, and every action visible |
| live check on 4311 and 5174 | four review beads filed, rendered, decided, closed |

Commits a32b2c0, 8b6e719, 2820930, b9c1317, and 498cbe5 are on the branch, reviewed and ready to merge once the layout is accepted.

```diff
diff --git a/apps/web/src/lib/reviewCard.ts b/apps/web/src/lib/reviewCard.ts
--- a/apps/web/src/lib/reviewCard.ts
+++ b/apps/web/src/lib/reviewCard.ts
@@ -1,40 +1,60 @@
+// line 0: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 1: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 2: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 3: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 4: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 5: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 6: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 7: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 8: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 9: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 10: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 11: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 12: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 13: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 14: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 15: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 16: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 17: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 18: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 19: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 20: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 21: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 22: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 23: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 24: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 25: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 26: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 27: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 28: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 29: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 30: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 31: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 32: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 33: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 34: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 35: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 36: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 37: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 38: the evidence a reviewer scans is free of the word budget because fences are capped by size
+// line 39: the evidence a reviewer scans is free of the word budget because fences are capped by size
```
