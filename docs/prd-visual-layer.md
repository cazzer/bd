# PRD — Visual layer

Status: proposed. Output of a jam session, 2026-09-01. Supersedes the sketch in `bd-1nf`.

## Problem

The brain has no observable surface. Today the only way to see what it contains is an MCP
call from a Claude session or a hand-written probe script — which is how the dogfood in
`bd-vt2.6` was done, and it's why the most important finding (15 structural edges, zero
semantic ones) took a bespoke script to notice.

Two questions are currently unanswerable by looking:

1. **Is the graph any good?** `bd-8no` says the corpus encodes directory co-location rather
   than meaning. That is a claim about shape, and shape is what eyes are for.
2. **Does retrieval do the right thing?** `bd-55t` defers the embeddings decision pending
   evidence. Evidence means watching real queries return real subgraphs.

There is also no way to *correct* the graph. An agent writes edges; when it links badly or
misses a link, there is no surface for a human to fix it.

## Proposed solution

A local-only React app: a search bar and a progressively-loading force-directed graph.

Search finds seed nodes and draws their immediate neighbourhood. Clicking a bubble expands
that node's neighbours into the view. Bubbles are sized by how connected a node is; colour
carries type. Clicking through to a node opens its markdown in a WYSIWYG editor.

The graph grows outward under the user's finger rather than rendering everything at once —
this is an ego-network view, which is what the retrieval query already computes, and it is
specifically *not* the global-graph "hairball" that the architecture handoff rejected
Obsidian for.

Because edges carry `weight` and `source_system`, the view makes provenance visible: edge
colour by source system and thickness by weight means `bd-8no` becomes self-evident on
open — one uniform colour is a graph that knows only directory structure.

## Success criteria

- [ ] Typing a query shows its result as a graph within one interaction, no script required.
- [ ] Clicking a node expands its neighbours **without existing nodes jumping** — spatial
      memory survives expansion.
- [ ] Edge provenance is visible at a glance; the zero-semantic-edges finding is obvious
      without reading a bead.
- [ ] A human can add, remove, and reweight an edge, attributed as `source_system: 'human'`.
- [ ] Editing an agent- or human-authored node's content round-trips through the editor
      without corrupting it.
- [ ] Nothing the UI writes can bypass ingest-run attribution, the dedup key, or the merge
      invariants.

## Scope

### In scope

- `apps/web`: Vite + React + TypeScript + Tailwind, built and served locally.
- A tRPC layer wrapping the existing `packages/core` API. Bound to localhost.
- Search → `retrieve()` at `maxDepth: 1`; click → a limited, weight-ordered neighbour fetch.
- Canvas 2D force-directed rendering with progressive expansion.
- Node degree as a first-class, queryable property.
- tiptap editor with `@tiptap/markdown`, for editable nodes only.
- Hand edge editing: assert, retract, reweight.
- Creating a `note` node: free-standing, or as an annotation of an existing node.

### Out of scope

- **Any network exposure.** Localhost only; no auth, no JWT, no RLS — consistent with the
  documented single-user decision. Exposure later is a perimeter change (scoped role +
  `statement_timeout`), not a rewrite.
- **PostgREST / pg_graphql / Supabase wire layer.** See Key decisions.
- **Editing repo-sourced nodes.** Read-only, badged with their file origin.
- **A global "show the entire graph" view.** The failure mode this design exists to avoid.
- Mobile, multi-user, collaborative editing, embeddings.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Wire layer | **tRPC over `packages/core`**, not PostgREST or pg_graphql | PostgREST RPC returns untyped `Record<string, unknown>[]` and `supabase gen types` can't infer RPC jsonb shapes — the one endpoint that matters would arrive untyped, defeating the "typed queries" goal. pg_graphql is concretely broken for a self-referential edges table (`pg_graphql#541`, `#502`) and the GraphQL spec disallows the recursion this domain is built on. |
| Portability | The seam is the TS function boundary | tRPC wraps arbitrary TypeScript, so swapping Postgres for Supabase behind `retrieve()` never touches the client contract. A PostgREST-typed client is coupled to schema-generated wire shapes — that is the path that would need a rewrite. |
| Backend | There already is one | `packages/core` is the backend: 210 tests, every invariant enforced. Generating a server adds a wire format in front of it and removes the types. Transport is ~50 lines. |
| Write path | Never auto-generated, never raw DML | Anything pointed at the tables bypasses ingest-run attribution, the dedup key, and the merge invariants. `mergeNodes` alone does row locking, deadlock retry, and chain collapse. |
| Rendering | **Canvas 2D** via `react-force-graph` (`ForceGraph2D`) | Benchmarks: SVG ~2k nodes, Canvas 5–7k, WebGL pays off past ~10k. Progressive loading keeps on-screen count in the hundreds. Decisively: sigma.js, the reference WebGL graph library, still draws labels with Canvas `fillText` on an overlay — there is no WebGL path that avoids Canvas for text, so three.js costs the labels and buys nothing. |
| Layout stability | Identity-preserving `d3-force` updates | Seed new nodes at their parent's coordinates, reuse node *objects* (d3-force tracks by identity — never reconstruct), and `alphaTarget(0.3)`-then-decay rather than `restart()`, which resets alpha to 1 and reflows the whole graph. |
| Bubble size | **√degree**, global not subgraph-local | Circle-size perception tracks area, so linear radius makes a 10× hub look 100× heavier. Global degree keeps sizes stable while exploring; subgraph-local degree would resize everything on every click. |
| Score encoding | Transient highlight, never geometry | Relevance is a property of a *question*, not of a node. Nodes arriving by click have no score at all. Encoding it in size would make the map shift under the user on every search. |
| Editor | **tiptap** + official `@tiptap/markdown` | Closes `bd-247` (tiptap vs Plate). MIT; only Tiptap Cloud is paid, which is irrelevant locally. |
| Repo nodes | Read-only, but **annotatable** | A "add note" action creates a separate `note` node, `source_system: 'human'`, joined by an `annotates` edge. Keeps `db:seed` idempotent and the file authoritative, while giving the app somewhere to think. The real argument: every note written becomes a human-authored semantic edge, so `bd-8no`'s missing meaning gets populated as a side effect of ordinary use rather than as a chore. |
| Degree | **Computed per query for the returned nodes only** | No global degree table and no refresh strategy. For the nodes a query returns, count their edges in a scoped aggregate joined into the same statement — a keyed lookup on indexed columns, not a full-table aggregate. Always fresh; staleness cannot happen. |
| Node creation | In scope for v1 — blank notes and annotations | Mostly implied by the annotation flow. Makes the app somewhere to write, not only somewhere to look. A blank note created free-floating has degree 0 and is reachable only by search until it is linked; that is acceptable and expected. |
| Editable nodes | Agent- and human-authored only; repo nodes read-only | Two independent reasons. `pnpm db:seed` upserts by `(source_system, external_id)` and would silently clobber a hand edit with whatever is on disk. And markdown round-trip is documented-lossy — table cell line breaks collapse, footnotes and raw HTML drop — so opening a wild corpus document in WYSIWYG and saving would normalize it. The file is the source of truth for those nodes; the UI shouldn't pretend otherwise. |

## New work in existing packages

- **Node degree.** Nothing exposes it. Computed per query for the returned node set — not
  globally materialized. Must still be counted over *canonical* nodes, with endpoints folded
  through `merged_into` and merge-induced self-loops excluded, or a merged pair shows inflated
  degree and a node appears linked to itself.
- **Bounded neighbour fetch.** `getNeighbors` has no limit; the MCP server applies its budget
  at its own layer. A hub with 500 neighbours would dump 500 bubbles on one click. Needs a
  limit plus weight-descending ordering, with a "show more" tail.
- **Human write surface.** Create a `note` node, update an editable node's content, and
  assert/retract/reweight an edge — all attributed to an ingest run with
  `source_system: 'human'`, so hand-authored content stays distinguishable from both the
  loaders and the agent.

## Open questions

Resolved in the jam: repo nodes are annotatable rather than editable, degree is computed per
query, and node creation ships in v1. Remaining:

- [ ] Should `annotates` edges be weighted below 1.0? A human assertion is the most confident
      signal in the system, but a uniform 1.0 means the weight column carries no information
      for the human source — which is the one source we most want to trust.
- [ ] Does an annotation inherit any filterable property from its target (node type, source
      system), or is it purely joined by the edge? Affects whether "show me my notes about
      OpenSpec" is a filter or a traversal.

## Dependencies

- `bd-8no` (zero semantic edges) — this PRD's diagnostic value depends on there eventually
  being semantic edges to look at. The visual layer makes the problem visible; it does not
  solve it.
- `bd-247` (editor library) — resolved here: tiptap.
- `bd-1nf` (web app slice) — superseded by this PRD.
- `bd-wq4` (`getNodesByExternalId`) — not blocking, but the UI is a second consumer that
  would want it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Canvas 2D ceiling (~5–7k nodes) is closer to real usage than it feels | M | M | Progressive loading is the mitigation by design. Keep render logic behind a boundary so a WebGL swap doesn't touch interaction code. Resist any "show the whole graph" feature — it is the one request that breaks the assumption. |
| Markdown round-trip damages content | M | H | Repo nodes read-only. For editable nodes, treat the WYSIWYG round-trip — not arbitrary hand-written markdown — as the fidelity contract, and say so in the UI. |
| Force layout still feels unstable despite the technique | M | M | Pin pre-existing nodes with `fx`/`fy` for the first ticks after an expansion so only the new subgraph moves. |
| Free-floating notes accumulate as unreachable orphans | M | L | Degree-0 notes are findable by search but invisible in the graph. Surface an "unlinked notes" list so they can be connected rather than silently lost. |
| Graph becomes a toy that is never used, as with Obsidian | M | M | The search bar, not the graph, is the entry point. If the graph proves to be decoration, the panels and provenance lists remain the useful half — build them first. |
| Two API surfaces (MCP tools + tRPC procedures) drift | L | M | Both are thin adapters over one core; invariants live in `packages/core`, which is the tested layer. Adapters that hold no logic cannot meaningfully drift. |
