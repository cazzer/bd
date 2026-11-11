---
key: budget
question: "Cap the enrichment workspace at $60/mo with a $10 per-run limit?"
options:
  - { id: A, label: "$60/mo, $10 per run", what: "Dedicated workspace, auto-reload off, MAX_USD=10 in code.", risk: "A long run stops at $10 and resumes next run." }
  - { id: B, label: "$100/mo", risk: "More headroom; the per-run cap is still needed." }
recommend: A
---
One decision of several filed for one epic in one call. The frontmatter `key` names it, so the review it files is found again on a re-run even though the file is called `keyed-budget.md`.
