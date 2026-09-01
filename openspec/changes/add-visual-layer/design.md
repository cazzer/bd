## Context

`packages/core` is already the backend: `retrieve`, `getNodes`, `getNeighbors`, `getStoreSummary`, the batch write path, and `mergeNodes`, with 210 tests and every store invariant enforced inside it. What is missing is not a backend but a way to look at one. See proposal.md for why that matters now.

The decision record behind this design is `docs/prd-visual-layer.md`, which resolved the wire layer, the rendering technology, the editor, and the read-only/annotation question. This document explains how those choices get implemented, not whether to make them.

Constraints that shape everything below:

- Single user, one machine, no network exposure. Security is a perimeter question deferred by binding to loopback, not an architecture question answered here.
- On-screen node count stays in the hundreds because the graph loads progressively. This is what makes the rendering choice easy.
- The store's guarantees live in `packages/core`. Any path to the database that goes around it is a path around them.

## Goals / Non-Goals

**Goals:**

- A person can see the shape of the graph, and its shape tells the truth about its provenance.
- Expansion feels like the graph growing rather than redrawing.
- A person can correct the graph, and their corrections are as attributable as an agent's.
- The transport layer stays thin enough to be replaceable without touching the browser code.

**Non-Goals:**

- Rendering the whole store. Design-level as well as product-level: no code path should assemble an unbounded node set.
- Serving anyone but the person at the keyboard.
- Lossless markdown for arbitrary input. The fidelity contract is round-tripping content authored in this editor.

## Decisions

### tRPC over `packages/core`, not a generated API

The browser talks to a small tRPC server that calls the existing exported functions. Types flow from the server's procedure definitions into the client by inference — no code generation, no schema sync step.

*Alternatives rejected, both from the PRD:* PostgREST returns `Record<string, unknown>[]` for RPC and `supabase gen types` cannot infer RPC jsonb shapes, so retrieval — the one endpoint that matters — would arrive untyped. pg_graphql is broken for a self-referential edge table (`pg_graphql#541`, `#502`) and the GraphQL specification disallows the recursion this domain is built on.

The portability argument runs opposite to intuition: because tRPC wraps arbitrary TypeScript, the seam sits at the function boundary, so replacing Postgres with a hosted service behind `retrieve()` never changes the client contract. A generated client is coupled to schema-derived wire shapes and is the harder thing to move.

### Writes go through core, never near the tables

The server exposes procedures that call `upsertNodes`, `upsertEdges`, and the new human-write functions. It does not expose table access or SQL. This is not a policy the server enforces so much as a shape it has: there is no code path from a request to the database that does not pass through the functions holding the invariants.

This matters concretely — attribution, the dedup key, content validation, and the merge chain-collapse logic all live in those functions. A generated CRUD layer over `nodes` and `edges` would bypass every one of them.

### Degree is computed per query, for the returned nodes only

No materialized view and no refresh strategy. For the node set a query returns, degree is a scoped aggregate joined into the same statement — a keyed lookup on indexed columns rather than a full-table count. Staleness cannot occur because nothing is stored.

Degree must be counted the way retrieval already counts everything else: over canonical nodes, endpoints folded through `merged_into`, merge-induced self-connections excluded. The self-connection guard already exists in the edge-assembly path; the same guard applies here, and getting it wrong makes a merged node appear connected to itself.

*Alternative rejected:* a materialized view refreshed on write. Faster reads for a number that is cheap to compute, in exchange for write-path work and a staleness window that shows up precisely when inspecting what an agent just did.

### Canvas 2D via `react-force-graph`, not WebGL

Published benchmarks put SVG's practical ceiling near 2,000 nodes, Canvas 2D at 5,000–7,000, and WebGL's advantage beyond roughly 10,000. Progressive loading keeps this application in the hundreds.

The decisive argument is text. sigma.js — the reference WebGL graph library — renders geometry in WebGL but draws every label with Canvas `fillText` on an overlay. There is no WebGL path that avoids Canvas for labels; SDF glyph atlases exist but are built for large pinned label sets, not a few hundred dynamic titles. WebGL would therefore cost the labels and buy nothing at this scale.

`react-force-graph` wraps `d3-force` with a canvas renderer while exposing the simulation object, which is what makes incremental addition a mutation rather than a re-initialisation.

### Layout stability is a technique, not a hope

The requirement that expansion not move placed nodes is met by three specific things: new nodes are seeded at the coordinates of the node they were expanded from; existing node **objects** are reused when merging new data, because `d3-force` tracks state by object identity and reconstructing the array discards every position; and the simulation is reheated with `alphaTarget` decaying to zero rather than `restart()`, which resets alpha to 1 and reflows the entire graph.

If that proves insufficient in practice, the next lever is pinning pre-existing nodes with `fx`/`fy` for the first ticks after an expansion so only the new subgraph moves.

### Size is what a node is; colour is what the query said

Radius scales with the square root of degree, because perceived circle size tracks area — linear radius makes a ten-times hub look a hundred times heavier. Degree is global, so a node is the same size in every view.

Query relevance is deliberately kept out of geometry. Relevance belongs to a question, not to a node, and nodes arriving by expansion have none at all; encoding it in size would resize the map on every search. It becomes a transient highlight instead.

### Repo-sourced nodes are read-only, for two independent reasons

Editing them would be clobbered: `db:seed` upserts by `(source_system, external_id)` and would overwrite a hand edit with whatever is on disk. And the markdown round-trip through `@tiptap/markdown` is documented-lossy — table cell line breaks collapse, footnotes and raw HTML drop — so opening a wild corpus document in a WYSIWYG and saving would normalise it.

Annotation is the escape valve: a separate `note` node joined by an `annotates` edge. This also does useful work beyond editing, since every annotation is a human-authored semantic edge, which is the gap the corpus currently has.

`note` requires no migration — `node_type` is open text by existing design.

## Risks / Trade-offs

- **Canvas's ceiling is nearer than it feels** (5,000–7,000 nodes against a stated few hundred) → progressive loading is the structural mitigation; keep rendering behind a boundary so a later WebGL swap does not touch interaction code, and treat any "show everything" feature as the thing that breaks the assumption.
- **Markdown round-trip damages content** → repo nodes read-only; for editable nodes the contract is round-tripping what this editor authored, stated in the interface rather than assumed.
- **Layout still feels unstable** → pin existing nodes for the first ticks after expansion.
- **Free-floating notes become orphans** → degree-zero notes are searchable but invisible in the graph; surface an unlinked-notes list rather than letting them silently accumulate.
- **Two adapters over one core** (MCP tools and tRPC procedures) → acceptable because neither holds logic; the invariants and the tests live in `packages/core`, and adapters that hold no logic cannot meaningfully diverge.
- **Degree computed per query costs a join on every read** → measured against the alternative's staleness, and the aggregate is keyed on indexed columns; revisit only with evidence.

## Migration Plan

Additive throughout. No schema migration: degree is computed, and `note` is an ordinary node type. `apps/mcp` is untouched. Rollback is not installing the app — nothing existing changes behaviour.

## Open Questions

- Should `annotates` edges carry a weight below 1.0? A human assertion is the most confident signal in the system, but making every human edge 1.0 means the weight column carries no information for the source we most want to trust. Deferrable: it changes a constant, not the specs or the task breakdown.
- Does an annotation inherit filterable properties from its target, or is it reachable only by traversal? Decides whether "my notes about OpenSpec" is a filter or a graph walk. Deferrable until there are enough annotations to want either.
