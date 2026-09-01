// Application tables (ingest_runs, nodes, edges, resolved_nodes) arrive in
// bd-vt2.2. This file intentionally exports nothing yet — it exists so
// drizzle-kit has a schema entry point to generate (empty) migrations
// against, and so packages/db typechecks as a real workspace member.
export {};
