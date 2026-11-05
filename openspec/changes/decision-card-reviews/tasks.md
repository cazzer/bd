## 1. Card contract in core

- [x] 1.1 Fixtures under `fixtures/review-cards/`: `shlo-k54.4.1.1.md` (the shlo card ported from `~/.local/share/breakdown/reviews/shlo/shlo-k54.4.1.1/01-card.png`: question, options A/B/C with risk, `recommend: A`, on-accept steps, the migration as a `diff` attachment, caller-audit and latency tables and findings in the body), `before-after.md` (an image `before`/`after` pair plus one mermaid ERD attachment, images committed beside it), invalid variants (question over 140, repeated option id, `recommend` naming no option, unknown kind, unknown top-level key, missing frontmatter); and for each valid card, `<name>.expected.json` — the `metadata.review` the CLI will write (decision 1: card keys plus `summary` = question and `images` = image attachment paths, with a placeholder root)
- [x] 1.2 `normalizeReviewMetadata` accepts the card keys per design.md decision 1 (structure breaks → invalid, over-long text fitted, NUL replaced, absent keys absent, idempotent, JSON cap); `ReviewMetadata` types exported; `reviewCard(review)` read helper (question or summary first line, attachments or images)
- [x] 1.3 Tests: every expected.json normalizes to itself; each structural break is invalid; each fitted field; a legacy `{ images, summary }` review normalizes byte-identical to before; `reviewCard` on legacy and card reviews; beads mapper and `beads-ingest-reviews` carry a card through a load and report a reload unchanged
- [x] 1.4 `listPendingReviews` summary line = question when present (design.md decision 2); test in `review-queue.test.ts` with fixtures scoped to their own project key
- [x] 1.5 `pnpm check` passes

## 2. review-request card form

- [x] 2.1 Root `package.json` adds `yaml` at an exact version; `pnpm install`; lockfile committed
- [x] 2.2 `parseArgs` form detection (design.md decision 4): no `--summary` + one `.md` positional → card form; legacy form unchanged; usage text shows both
- [x] 2.3 Card form: frontmatter split, `await import("yaml")` only in this branch (missing package → "run pnpm install in <root>"), strict validation naming the field, image attachments resolved relative to the card and validated before any write, body ≤ 8,000 characters
- [x] 2.4 Filing: description = body (question when empty), `metadata.review` = card + legacy keys, images staged as today, notification body = question; reuse/re-request path identical to the legacy form
- [x] 2.5 Tests: each fixture card produces its `expected.json` (root substituted); each invalid fixture refuses naming its field with nothing filed; the legacy form's existing tests pass untouched and a test asserts the legacy path never imports `yaml`
- [x] 2.6 `pnpm check` passes

## 3. Decisions name an option (server)

- [x] 3.1 `reviewDecision` input gains optional `option` (id pattern); router passes it through
- [x] 3.2 `review-writer.ts` checks the option against the pre-write `bd show` record's normalized review (design.md decision 5), refusing before any write; comment, close reason, and prompt texts with the option; texts without an option unchanged
- [x] 3.3 Tests with the injectable runner: choose non-recommended option, accept recommended with and without message, option not offered, accept without option on a card with options, option with `changes`, option on a legacy review, legacy accept/changes texts unchanged; router test for the input pattern
- [x] 3.4 `pnpm check` passes

## 4. Card layout prototypes (visual review gate)

- [x] 4.1 2–3 static prototypes of the card in the drawer and in the Review all run at 1440 × 900 (HTML in the session scratchpad, no app code), each filled from the shlo fixture and the before/after fixture, all honouring design.md decision 6's fixed points
- [x] 4.2 For each, its build cost: components touched, use of the run's stage/column split, keyboard model for Accept / Choose / Request changes
- [x] 4.3 Screenshot them and request the pick through `review-request bd-4zn` (image form, `Accept = <recommended>`); record the chosen layout as design.md decision 7

## 5. Evidence renderer

- [x] 5.1 Add `@tiptap/extension-table` (pinned to the installed Tiptap version) and `mermaid` to `apps/web`; confirm `@tiptap/markdown` parses GFM tables through TableKit, else stop and report (design.md decision 3)
- [x] 5.2 Read-only `EvidenceView`: StarterKit + Markdown + TableKit + CodeBlock with a node view dispatching `mermaid` / `diff` / default; `MarkdownEditor` and its extension set unchanged
- [x] 5.3 `DiffBlock` (line classes, screen-reader prefixes, React text only) and `MermaidBlock` → lazily imported `MermaidDiagram` (strict, `htmlLabels: false`, SVG shown only through `<img>` data URL, parse error shows source + error)
- [x] 5.4 Tests: tables render as tables; a `diff` fence marks added/removed lines; a `mermaid` fence mounts the lazy component; a broken diagram shows source and error; evidence containing `<script>`, an `<img onerror>`, and a mermaid source with an HTML/`javascript:` label produce no executable markup; build output shows mermaid in its own chunk not imported by the entry
- [x] 5.5 `pnpm check` passes

## 6. Card in the drawer and the run

- [x] 6.1 `ReviewItemPanel` renders through `reviewCard` in the order of the spec (question, recommended option, other options, on-accept, attachments, evidence) per the layout picked in 4.3; evidence collapsed when the card has question + options; legacy reviews read as before
- [x] 6.2 `ReviewAttachments` gains `mermaid` and `diff` kinds (reusing 5.3's blocks) and renders a `before` followed by an `after` side by side, labelled, in both `column` and `stage` layouts
- [x] 6.3 Decision actions: "Accept <recommended label>", "Choose <label>" per other option, "Request changes"; option id sent with the decision; the run modal's "& next" variants, arming, and shortcuts carry the option; legacy reviews keep Accept / Request changes
- [x] 6.4 Queue popover shows the question line (already served by 1.4); no other queue change
- [x] 6.5 Pure helpers unit-tested (action list from a card, pairing); `pnpm check` passes; screenshots at 1440 × 900 of the shlo card (drawer + run) showing question, recommendation, and actions above the fold

## 7. End-to-end check, guidance, and epic visual review

- [ ] 7.1 Live check (worktree servers on 4311/5174, `bd` registered in the worktree database): file the shlo card with the branch's `review-request` (`WEB_SERVER_PORT=4311`); it appears in the queue by its question; the drawer renders tables, the diff, and a diagram; "Choose B" writes `Accepted: B — …` and the prompt names B; an image-only review filed with the legacy form still renders and accepts as before
- [ ] 7.2 Update `~/.claude/skills/context/visual-review.md`: architecture and other human-in-the-loop decisions use the card form; how to write the question, options, recommendation, and before state; images only for what must be seen; never screenshot text; the legacy form still works
- [ ] 7.3 Request the epic visual review under `bd-4zn` as a decision card (card form, against the worktree server), with screenshots of the built card as image attachments
