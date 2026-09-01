## Why

The brain has no observable surface. Seeing what it contains requires an MCP call from a Claude session or a hand-written probe script — which is exactly how the `add-knowledge-graph-core` dogfood was done, and why its most important finding (fifteen structural edges, zero semantic ones) needed a bespoke script to notice.

Two open questions are unanswerable by looking. Whether the graph is any good — a claim about shape, and shape is what eyes are for. And whether retrieval does the right thing, which the deferred embeddings decision is waiting on evidence for. There is also no way to *correct* the graph: an agent writes edges, and when it links badly or misses a link entirely, no surface exists for a human to fix it.

## What Changes

- Add `apps/web`: a local-only React app whose entry point is a search bar, rendering results as a force-directed graph that grows outward as the user expands nodes.
- Add a tRPC server bound to localhost, wrapping the existing `packages/core` API as thin transport.
- Return **node degree** from retrieval, counted over canonical nodes, so bubbles can be sized by how connected a node actually is.
- Add a **bounded, weight-ordered neighbour fetch**. Today's neighbour lookup has no limit, so expanding a 500-neighbour hub would return all 500.
- Add a **human write surface**: create a note, edit an editable node's content, and assert, retract, or reweight an edge — all attributed to an ingest run with `source_system: 'human'`.
- Make repo-sourced nodes read-only but **annotatable**, via a `note` node joined by an `annotates` edge.
- Render edge provenance visually — colour by source system, thickness by weight — so a graph that encodes only directory structure looks like one.

## Non-Goals

- **No network exposure.** Localhost only; no auth, no JWT, no row-level security, consistent with the documented single-user decision. Exposure later is a perimeter change, not a rewrite.
- **No auto-generated API layer.** PostgREST returns untyped results for RPC and pg_graphql is broken for self-referential edge tables; both are rejected in the PRD.
- **No global "show the whole graph" view.** The hairball is the failure mode this design exists to avoid.
- **No editing of repo-sourced nodes.** Their source of truth is a file on disk.
- Mobile, multi-user, collaborative editing, and embeddings remain out.

## Capabilities

### New Capabilities

- `graph-explorer`: the observable behaviour of the visual layer — what search shows, how expansion behaves, how a node's connectedness and an edge's provenance are encoded, and what a person may edit.
- `local-web-api`: the contract of the local server between browser and store — what it exposes, what it refuses, and the guarantee that nothing reaching it can bypass the store's invariants.

### Modified Capabilities

- `knowledge-store`: gains the human write surface — hand-authored notes, annotations, and edges, attributed and invariant-preserving.
- `retrieval`: gains node degree as a returned property, and a bounded, ordered neighbour fetch.

## Impact

- New: `apps/web` (Vite, React, TypeScript, Tailwind), and a tRPC server alongside it.
- Changed: `packages/core` gains degree, bounded neighbours, and human-write functions.
- New dependencies: tRPC, `react-force-graph`, `d3-force`, tiptap with `@tiptap/markdown`, Tailwind.
- No schema migration is required — degree is computed per query, and `note` is an ordinary `node_type` in an open discriminator.
- `apps/mcp` is untouched and keeps working.
