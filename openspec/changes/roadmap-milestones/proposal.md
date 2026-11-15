## Why

Breakdown now tracks a dozen-plus beads projects, and the board answers "what's in flight" but not "how far along is each body of work, and is it on time". Beads already has a `milestone` issue type with a `due_at` date and records `started_at` when an item is claimed, but the importer drops both, so nothing in Breakdown can show a milestone or a schedule. At the same time the board's project chips no longer fit on one line, and an all-projects board is the default way in.

## What Changes

- **Milestones come in from beads.** An issue of type `milestone` is a work item like any other. Epics (and, when no epic fits, plain items) are its children through the existing `child_of` edge — `bd create -t epic --parent <milestone>` or `bd update <epic> --parent <milestone>`. No new edge type, no new node type.
- **The importer carries `due_at` and `started_at`** into work-item metadata, normalized to the same fixed-width instant form as `occurred_at`, and the work-item contract validates them at every writer.
- **A roadmap read**: one SQL statement per request answers each selected project's milestones, each epic's nearest milestone, and rolled-up progress (closed / in progress / open / deferred item counts) for every epic and milestone, plus the dates a timeline needs.
- **A roadmap view** at `/roadmap?project=<key>`: per project, milestones in due order, each with its epics as rows on a week-scaled timeline (bar from first start to close or today, a marker at the target date, a today line, overdue flagged), with progress bars on milestones and epics. Epics with no milestone sit in a "No milestone" group.
- **The board switches one project at a time** from a compact switcher (a single-select menu: "All projects" plus each project) in place of the chip row. **BREAKING (UI):** the chips go away; a link naming several projects still opens, showing those projects.
- **Board and Roadmap are sibling views** with a two-way toggle in the board header that carries the chosen project across.
- **Milestones are not board cards**; an epic's lane header names its milestone.

Not in this change: editing milestones or dates from the web (beads stays the writer), an MCP tool for the roadmap, cross-project milestones (beads parents can't cross checkouts), a `roadmap` view-node renderer, dependency arrows on the timeline.

Rejected alternatives:
- **Breakdown-native milestone nodes** (written by people in the web app) instead of beads milestones: they'd split one project's plan across two writers, and the Jetson has no `bd`, so a milestone written here couldn't parent a beads epic without a new relay action. Beads already models it; import it.
- **A `milestone` edge type** (epic → milestone) instead of `child_of`: the CLAUDE.md rule is that `child_of` is the one containment relation, and beads already writes the parent link as `parent-child`, which becomes `child_of`.
- **Multi-select dropdown** for the board: keeps the multi-project board but costs a click per project and still needs a summary label; the request is one project at a time.

## Capabilities

### New Capabilities
- `work-roadmap`: milestone and epic rollup, the roadmap read, and the roadmap view (timeline, progress, grouping, addressing).

### Modified Capabilities
- `work-items`: work items may carry `due_at` and `started_at` under the contract; the beads importer carries them; a `milestone` item's children are ordinary `child_of` children.
- `work-board`: the board is addressed by one chosen project through a compact switcher instead of chips; milestones are not cards; a lane header names its epic's milestone; Board and Roadmap toggle as sibling views.
- `local-web-api`: a `roadmap` read procedure beside `board`.

## Impact

- `packages/core`: `beads.ts` (map `due_at`, `started_at`), `work-items.ts` (contract fields), new `roadmap.ts` (one-statement read reusing the board's `child_of` walk shape and `registeredProjectsCte`), `board.ts` (exclude milestones from cards, return each lane epic's milestone).
- `apps/web`: `lib/route.ts` (`/roadmap` route), new `RoadmapView.tsx`, `BoardView.tsx` (switcher, toggle, lane milestone), server router (`roadmap` procedure, same scopes as `board`).
- One-time churn: the first ingest after deploy re-hashes every bead that has a `started_at` or `due_at`, so it reports them updated and writes one revision each.
- Deploy: a new image for the Jetson through the skyos manifest bump; one migration-free change (metadata only).
