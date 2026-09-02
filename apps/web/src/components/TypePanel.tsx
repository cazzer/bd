// Ranked node-type control (bd-14q, design.md "Type control: ranked by
// prevalence, defaults to top types, drives a canvas focus"). Replaces
// GraphLegend.tsx. App.tsx picks WHICH ranking this renders (by passing
// or omitting `selected`):
//   - no node selected: `storeTypes` is the full, unsliced
//     `getStoreSummary().nodeTypes` — this component itself sorts (via
//     `topStoreTypes`, never trusting the caller's order) and takes the
//     top 8, with a disclosure for the rest.
//   - a node selected: `selected.ranked` is already
//     `rankNeighborTypes(selectedId, graph.nodes, graph.links)`, derived
//     by App.tsx during its own render (no extra fetch) — shown in full,
//     no disclosure, since an on-screen neighbourhood is already small.
//
// Clicking a row toggles canvas type focus; App.tsx owns that state (and
// the mirrored search chip — design.md: "choosing a type this way also
// adds it as a search chip") and passes the current focused type back in
// as `focusedType` so the pressed row's `aria-pressed` stays correct.
//
// Edge-source-system swatches stay as a compact footer so the existing
// "Edge provenance is visible" requirement (graph-explorer/spec.md)
// remains satisfied now that GraphLegend itself is gone — this is the
// one piece of this component that isn't node-type ranking.

import { colorForNodeType, knownSourceSystemColors } from "../graph/palette.js";
import { topStoreTypes, type TypeCount } from "../graph/typePrevalence.js";

const DEFAULT_VISIBLE_COUNT = 8;

export interface TypePanelSelection {
  /** The selected node's own title, for the "around <title>" header. */
  title: string;
  /** rankNeighborTypes(selectedNodeId, graph.nodes, graph.links) — App.tsx derives this during render. */
  ranked: TypeCount[];
}

export interface TypePanelProps {
  /** getStoreSummary().nodeTypes — the full store-wide list; this component itself slices to the top 8 plus disclosure. */
  storeTypes: TypeCount[];
  /** null when no node is selected. */
  selected?: TypePanelSelection | null;
  /** The type currently focused on the canvas, or null. */
  focusedType: string | null;
  /** A row was activated — App.tsx decides whether that turns focus on or off. */
  onToggleFocus: (nodeType: string) => void;
  /** App.tsx's store-wide type-colour rank map (bd-4ye, palette.ts's `assignTypeColors`) — the SAME map GraphCanvas and SearchBar read, so a row's swatch never disagrees with the canvas. */
  typeColors: ReadonlyMap<string, string>;
}

function TypeRow({
  nodeType,
  count,
  focused,
  onToggleFocus,
  typeColors,
}: {
  nodeType: string;
  count: number;
  focused: boolean;
  onToggleFocus: (nodeType: string) => void;
  typeColors: ReadonlyMap<string, string>;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={focused}
        onClick={() => onToggleFocus(nodeType)}
        className={`flex w-full items-center gap-2 rounded-lg border-l-2 px-2 py-1 text-left text-[13px] focus:outline-none focus:ring-2 focus:ring-accent ${
          focused ? "border-accent bg-surface-strong" : "border-transparent hover:bg-surface-strong"
        }`}
      >
        <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorForNodeType(nodeType, typeColors) }} />
        <span className="flex-1 truncate text-fg">{nodeType}</span>
        <span className="shrink-0 text-fg-muted">{count}</span>
      </button>
    </li>
  );
}

export function TypePanel({ storeTypes, selected, focusedType, onToggleFocus, typeColors }: TypePanelProps) {
  const heading = selected ? `around ${selected.title || "(untitled)"}` : "Types";
  // `topStoreTypes(storeTypes, storeTypes.length)` — "top all of them" —
  // reuses the one tested sort/tie-break rather than re-sorting inline;
  // slicing into visible/rest happens here since only this component
  // knows about the disclosure.
  const rows = selected ? selected.ranked : topStoreTypes(storeTypes, storeTypes.length);
  const visible = selected ? rows : rows.slice(0, DEFAULT_VISIBLE_COUNT);
  const rest = selected ? [] : rows.slice(DEFAULT_VISIBLE_COUNT);

  return (
    <div className="flex flex-col gap-2 text-xs">
      <h2 className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{heading}</h2>

      {rows.length === 0 ? (
        <p className="text-fg-muted">{selected ? "no neighbours drawn" : "no types yet"}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <TypeRow key={row.nodeType} nodeType={row.nodeType} count={row.count} focused={focusedType === row.nodeType} onToggleFocus={onToggleFocus} typeColors={typeColors} />
            ))}
          </ul>
          {rest.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-fg-muted hover:text-fg">
                {rest.length} more type{rest.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {rest.map((row) => (
                  <TypeRow key={row.nodeType} nodeType={row.nodeType} count={row.count} focused={focusedType === row.nodeType} onToggleFocus={onToggleFocus} typeColors={typeColors} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-2">
        <span className="text-[10px] font-medium text-fg-muted uppercase">edge source</span>
        {knownSourceSystemColors().map(([system, color]) => (
          <span key={system} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-0.5 w-3 shrink-0" style={{ backgroundColor: color }} />
            <span className="font-mono text-[10px] text-fg-muted">{system}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
