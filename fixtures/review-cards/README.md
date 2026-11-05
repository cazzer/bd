# Decision-card fixtures

One fixture set run through both validators of the card contract
(openspec/changes/decision-card-reviews, design.md decisions 1 and 4), so the
CLI's strict validator (`bin/review-request-lib.mjs`) and the core normalizer
(`normalizeReviewMetadata` in `packages/core/src/reviews.ts`) cannot drift.

A card is one markdown file: YAML frontmatter between a leading `---` line and
the next `---` line holds the card (`question`, `options`, `recommend`,
`on_accept`, `attachments`); the body after it is the evidence, which becomes
the review bead's description. Image attachment paths are relative to the
card file. Every `source` is a `|-` block scalar, so it carries no trailing
newline however the frontmatter is sliced.

## Valid cards

| Card | What it exercises |
| --- | --- |
| `shlo-k54.4.1.1.md` | question, options A/B/C with `what`/`risk`, `recommend: A`, three on-accept steps, a `diff` attachment (the real migration diff, shlo `supa-backend` `7a641e1..7aa2657`, 7,151 characters), two tables in the body; no images |
| `before-after.md` | no options, one on-accept step, a `before`/`after` image pair (`before.png`, `after.png` beside it), a `mermaid` ER diagram |
| `long-recommendation.md` | the fold's worst case: a 140-character question, a recommended option A whose `what` and `risk` are 300 characters each, options B and C, a `diff` attachment (so the run has a stage); the board must show the question, all of A, and every action without scrolling at 1440 × 900 |

Each has `<name>.expected.json`: the exact `metadata.review` object the CLI
writes for that card, which `normalizeReviewMetadata` maps to itself. It holds
the legacy keys first and the card keys after, in the normalizer's key order:
`images`, `pane`, `socket`, `summary`, `question`, `options`, `recommend`,
`on_accept`, `attachments` (each attachment `kind`, `path` or `source`,
`caption`, `pair`; each option `id`, `label`, `what`, `risk`). Card keys a
card leaves out are absent, never empty arrays.

- `summary` is the question; `images` is the image attachments' stored paths,
  in attachment order.
- **Whole-review cap.** `JSON.stringify` of the written review is at most
  16,000 characters (`MAX_REVIEW_METADATA_CHARS`); the CLI refuses a card
  over it, and the normalizer marks a stored one invalid. The shlo card is
  8,686.
- **Placeholder root.** A stored image path is written as
  `/REVIEW_ROOT/PROJECT/BEAD/NN-<basename>`, where `NN` is the 1-based,
  two-digit position among the card's image attachments. A test substitutes
  the literal prefix `/REVIEW_ROOT/PROJECT/BEAD` with the review's real image
  directory (`<home>/.local/share/breakdown/reviews/<project>/<review-bead>`).
  The placeholder is absolute so the normalizer accepts the files unsubstituted.
- `pane` and `socket` come from the requester's environment, not the card: the
  files are written as if `HERDR_PANE_ID=w1:p1` and
  `HERDR_SOCKET_PATH=/tmp/herdr-test.sock`. A test runs the CLI with exactly
  those values.

## The CLI is stricter than the normalizer

Every card the CLI accepts normalizes to itself; the converse does not hold.
Where the normalizer fits, drops, or treats as absent, the CLI refuses,
naming the field, so an author learns of the problem instead of losing text:

| Input | CLI | Normalizer |
| --- | --- | --- |
| text over its cap (question 140, label 80, what/risk 300, step 200, caption 200, source 8,000) | refused | fitted |
| body over 8,000 characters | refused | (not in metadata) |
| `options: []`, or fewer than 2 / more than 6 | refused | `[]` absent; otherwise invalid |
| `recommend: ""` | refused | absent |
| `recommend` without options | refused | invalid |
| a blank on-accept step | refused | dropped |
| a blank or missing `label` | refused | invalid |
| a non-string `id` or `label` | refused | invalid |
| an unknown key inside an option or attachment | refused | dropped |
| an unknown top-level key | refused | dropped |
| an empty mermaid/diff `source` | refused | kept |
| NUL in any text field | refused | replaced by U+FFFD |
| a blank optional `what`, `risk`, or `caption` | left out | left out |
| `on_accept: []`, `attachments: []` | left out | left out |

## Invalid cards

The CLI refuses each, filing nothing, naming the field:

| Card | Field |
| --- | --- |
| `invalid-question-too-long.md` | `question` (160 characters, limit 140) |
| `invalid-repeated-option-id.md` | `options` (id `A` repeats) |
| `invalid-recommend-unknown.md` | `recommend` (`D`, options are A, B, C) |
| `invalid-unknown-kind.md` | `attachments` (kind `video`) |
| `invalid-unknown-key.md` | `recomend` (unknown top-level key) |
| `invalid-missing-frontmatter.md` | frontmatter |

The normalizer, which never refuses, fits an over-long question and drops an
unknown key; the repeated id, unknown recommendation, and unknown kind make
the review `{ invalid: true }`. Core tests cover those as inline objects —
core has no YAML parser and reads only the `expected.json` files.

## What only the CLI refuses

Beyond the contract the normalizer enforces, the CLI refuses at authoring
time, naming the field, wherever the normalizer would fit, drop, or replace:

- over-long text in any field (the normalizer fits it); a question that is not
  one line; a body over 8,000 characters;
- unknown keys at any level — top-level, in an option, in an attachment;
- `options: []`, `recommend: ""`, a blank `label`, a blank `on_accept` step, a
  blank `source`;
- an option id or `recommend` that YAML read as a number (`id: 1` → quote it);
- NUL or an unpaired surrogate in any text, source, or the body;
- a card file that is not a regular file or is over 64 KB; frontmatter that is
  not valid YAML (reported at the card file's line);
- a review whose JSON would exceed 16,000 characters with its stored paths
  (checked after the read-only lookups, before anything is staged or written).
