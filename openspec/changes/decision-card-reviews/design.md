## Context

See proposal.md for why; the contract was decided in `bd-4zn`'s design field (2026-11-05). What exists:

- `packages/core/src/reviews.ts` — `normalizeReviewMetadata` turns a bead's `metadata.review` into `{ images, pane, socket?, summary }` or `{ invalid: true }`, never throwing, idempotent, JSON-length capped (`MAX_REVIEW_METADATA_CHARS` 16,000). `beads.ts` applies it to issues labelled `review`; `review-queue.ts` derives the queue's summary line and image count from it; `getBoardItem` returns the item's `content` (the bead description) beside the review.
- `bin/review-request-lib.mjs` — dependency-free Node ESM, symlinked into `~/.local/bin`; `--summary` required, at least one image; writes the summary as the description (`-d`) and `metadata.review` with `bd update --metadata`; notifies with the summary as body.
- `apps/web/server/routers/review.ts` + `review-writer.ts` — `reviewDecision({ project, item, decision, message })`, a pre-write `bd show` (the tracker's record is trusted for pane and socket, never the store), then comment, close/label, wake, prompt. Texts: `Accepted: <m>` / `Accepted.`, close reason `Review accepted`, prompt `Review <id> accepted: <m>`.
- `ReviewItemPanel` (shared by `ReviewDrawer` and `ReviewRunModal`) renders summary, attachments through `ReviewAttachments` (one slot keyed by kind, `layout: "column" | "stage"`; review-queue decisions 6–7 reserved before/after as a cross-kind `pair`), thread, and the decision form.
- `MarkdownEditor` — Tiptap with a fixed `[StarterKit, Markdown]` set used for both read-only display and editing; its header documents why no markdown becomes an HTML string.

## Goals / Non-Goals

**Goals:** a typed card the drawer can act on; markdown evidence with tables, diagrams, and diffs; one-file authoring; every existing review and the current CLI form unchanged at every commit.

**Non-Goals:** editing a card from the board; tables or diagrams in the node editor (DetailPanel) — the evidence renderer is read-only and separate; server-side rendering of diagrams; attachments other than image, mermaid, diff; changing how review images are served.

## Decisions

### 1. One review object, card keys beside the legacy keys

`ReviewMetadata` keeps `images`, `pane`, `socket?`, `summary` and gains optional `question`, `options`, `recommend`, `on_accept`, `attachments`. Normalization rules, in `normalizeReviewMetadata` (so the beads mapper, the board read, and the server's decision check share one definition):

- **Structure breaks → `{ invalid: true }`**: a non-string question; options not an array of 2–6 plain objects; an option `id` not matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$` or repeated; a missing `label`; `recommend` present without options or naming no option; `on_accept` not an array of strings or longer than 8; attachments not an array, more than 20, an unknown `kind`, an image without an absolute control-character-free `path` (same rule as `images`), a mermaid/diff without a string `source`, a `pair` other than `before`/`after`.
- **Over-long text → fitted** with `fitText`, like `summary` today: question 140, label 80, what and risk 300, each on-accept step 200, caption 200, attachment source 8,000. NUL becomes U+FFFD in every text field. The whole-review JSON cap (16,000) still applies after fitting; the evidence body is not in metadata, so the cap is ample for a card.
- Absent card keys are absent in the output (not empty arrays), so a legacy review normalizes byte-identical to today and reloads report it unchanged.

Rejected: a second metadata key (`card`) — two objects to keep consistent and two normalizers at every writer; refusing over-long text in the normalizer — one stray character would invalidate a review a hand edit produced, while the CLI already refuses it at authoring time.

**Reading a card** is a pure helper beside the normalizer, `reviewCard(review)`: `question` if present, else the summary's first line fitted to 140; attachments if present, else `images` as image attachments without caption or pair. Every UI reads through it, so a legacy review is a question-only card with its images.

**The CLI writes the legacy keys too**: `summary` = the question and `images` = the image attachments' stored paths. A reader built before this change (main's board, an open tab mid-branch) therefore still shows the question and the images, and the queue's image count stays right with no change to its SQL.

### 2. Queue line reads the question

`listPendingReviews` keeps one statement; its summary line becomes `coalesce(question, first line of summary)` from the stored metadata, still cut to 200. No other queue change.

### 3. Evidence: a separate read-only renderer

`MarkdownEditor`'s extension set is shared with editing; adding tables there would change how every editable node serializes. Instead a read-only `EvidenceView` (same module family, same safety argument cited from MarkdownEditor's header) uses `StarterKit`, `Markdown`, `TableKit` from `@tiptap/extension-table` (pinned to the installed Tiptap 3.31.0), and a `CodeBlock` extended with a read-only React node view: `language === "mermaid"` → `MermaidBlock`, `language === "diff"` → `DiffBlock`, anything else → the default `<pre>`. If `@tiptap/markdown` does not parse GFM tables through TableKit's markdown handlers at 3.31.0, the implementer stops and reports rather than adding a second markdown parser.

- **`DiffBlock`**: lines split on `\n`; a leading `+`, `-`, `@@` gets a class (and a visually hidden "added"/"removed" prefix for screen readers); rendered as React text, never HTML.
- **`MermaidBlock`**: `lazy(() => import("./MermaidDiagram"))`, so `mermaid` is its own chunk fetched the first time a diagram renders (verified in the build output). `MermaidDiagram` initializes mermaid once with `startOnLoad: false`, `securityLevel: "strict"`, `htmlLabels: false`, and renders to an SVG string that is shown **only as `<img src="data:image/svg+xml;…">`** — an SVG loaded as an image never runs script or loads resources, so the strict-mode sanitizer is a second layer, not the only one. A parse error shows the source in a `<pre>` with the error text. The diagram is announced by an accessible name from the caption (or "Diagram").

The same `MermaidBlock` and `DiffBlock` render `mermaid` and `diff` attachments, so evidence fences and attachments look identical.

Rejected: `dangerouslySetInnerHTML` of mermaid's SVG (inline SVG can carry script; the renderer's documented property is that no markup string reaches the DOM); rendering diagrams server-side (a headless browser on the server); a raw `marked` renderer for evidence (a second parser with its own safety story).

### 4. CLI: `review-request <item> <card.md>`

Form detection in `parseArgs`: no `--summary` and exactly one positional after the item id that ends in `.md` → card form; otherwise the legacy form, byte-for-byte unchanged (an `.md` with `--summary` is still refused as not an image). The card form:

1. Reads the file, splits a leading `---\n…\n---\n` frontmatter (refusing "missing frontmatter"), parses it with the `yaml` package loaded by `await import("yaml")` **only in this branch**, so the legacy form never loads it and keeps working in a checkout that has not run `pnpm install` since this lands. A missing package is refused as "run pnpm install in <breakdown root>".
2. Validates with the same rules as decision 1 but strictly — refusing, naming the field (`question: at most 140 characters, got 163`), where the normalizer would fit — plus: question required; unknown top-level keys refused (typos must not silently drop a field); body ≤ 8,000 characters; image attachments resolved relative to the card file and checked like today's images (exist, image extension).
3. Files exactly as the legacy form does (reuse rules, staging, `blocks`, notification), with description = body (or the question when the body is empty), `metadata.review` = the card plus the legacy keys from decision 1, and the notification body = the question.

The validator lives in the CLI (plain JS, no import from `packages/core`, which needs the workspace toolchain), and a shared test fixture set — the shlo card, a before/after image card, and invalid variants — is run through both the CLI validator and `normalizeReviewMetadata` so the two cannot drift: every card the CLI accepts normalizes to itself.

`yaml` (eemeli/yaml, no dependencies) is added to the root `package.json` at an exact version. Rejected: a hand-written YAML subset (quoting and colon edge cases in exactly the prose agents write); JSON frontmatter (correct, but agents and people write YAML).

### 5. Decisions carry an option id

`reviewDecision` gains `option?: string` (same id pattern). The router passes it through; `review-writer.ts`, after its existing pre-write `bd show`, normalizes the tracker's `metadata.review`: options present + `accept` without `option` → refused; `option` not among the record's ids → refused; `option` with `changes` or on a review without options → refused. Refusals are 4xx before any write. Texts: comment `Accepted: <id> — <m>` / `Accepted: <id>.`; close reason `Review accepted: <id>`; prompt `Review <bead> accepted: <id> — <m>` / `Review <bead> accepted: <id>.`. Without an option every text is exactly today's. The option is checked against the tracker's record, not the store, for the same reason pane and socket are (any agent can write a store node).

### 6. Card layout is chosen before it is built

The card UI groups begin with 2–3 static prototypes (HTML in the session scratchpad, no app code) of the card in the drawer and in the Review all run at 1440 × 900, filled from the shlo fixture and the before/after fixture, each with its build cost (components touched, how the stage/column split of review-queue decision 7 is used, keyboard model). Screenshots go through `review-request bd-4zn` as an image review (the board that receives it predates cards), with `Accept = <recommended>` per visual-review.md. The pick is recorded here as decision 7 before the card UI is built. Fixed for every prototype: question first; recommended option with its risk and the decision actions above the fold; evidence collapsed when the card has question + options; attachments before evidence; `before`/`after` pairs side by side.

### 7. (Reserved for the picked layout.)

## Risks / Trade-offs

- [The `yaml` import fails on a checkout that has not reinstalled] → card form only, with an exact remedy; legacy callers in tides/shlo/tick-dog never reach it.
- [mermaid is large (~1 MB+ minified with its diagram types)] → its own chunk, fetched only when a diagram renders; the board and the queue never pay for it.
- [An SVG drawn through `<img>` cannot use page fonts or link out] → diagrams are for reading; text uses mermaid's default font stack. Accepted.
- [Between group 3 (server requires an option for a card with options) and group 6 (buttons that send one), the branch's drawer cannot accept such a card; Request changes still works] → accepted: only the branch's own CLI (group 2) can file a card, legacy reviews are unaffected at every commit, and main never sees the intermediate state.
- [Two validators (CLI and core) drift] → one fixture set run through both, decision 4.

## Migration Plan

No data migration. Legacy reviews normalize unchanged. After merge: `pnpm install` in the main checkout (for `yaml`, needed only by the card form), then the visual-review.md update tells agents about the card form. Rollback is reverting the branch; card keys are inert to the previous normalizer only in the sense that it ignores them — a reverted normalizer keeps `{ images, summary }`, and the CLI wrote both.
