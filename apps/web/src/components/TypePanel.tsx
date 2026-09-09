// Ranked node-type control (bd-14q, design.md "Type control: ranked by
// prevalence, defaults to top types, drives a canvas focus"). Replaces
// GraphLegend.tsx. App.tsx picks WHICH ranking this renders (by passing
// or omitting `selected`):
//   - no node selected: `storeTypes` is the full, unsliced
//     `getStoreSummary().nodeTypes` — this component itself sorts (via
//     `topStoreTypes`, never trusting the caller's order) and takes the
//     top 8; everything past the palette lands in the overflow group.
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

import { colorForNodeType, FALLBACK_COLOR } from "../graph/palette.js";
import type { EdgeLegend } from "../graph/edgeLegend.js";
import { splitPaletteOverflow, topStoreTypes, type TypeCount } from "../graph/typePrevalence.js";

/** CATEGORICAL_PALETTE's slot count — every type past it shares FALLBACK_COLOR and lands in the overflow group instead. */
const DEFAULT_VISIBLE_COUNT = 8;

export interface TypePanelSelection {
  /** The selected node's own title, for the "around <title>" header. */
  title: string;
  /** rankNeighborTypes(selectedNodeId, graph.nodes, graph.links) — App.tsx derives this during render. */
  ranked: TypeCount[];
}

export interface TypePanelProps {
  /**
   * The types actually DRAWN, ranked (bd-857, typePrevalence.ts's
   * `drawnTypeCounts`). The primary figure in the no-selection view.
   *
   * Before this, the panel led with `storeTypes` — so it read
   * `gh-pr 584` beside a canvas holding no `gh-pr` at all. A legend that
   * does not describe the picture next to it is worse than no legend,
   * because a reader takes it as a key to what they are looking at.
   */
  drawnTypes: TypeCount[];
  /** getStoreSummary().nodeTypes — the full store-wide list. Still shown, as the SECONDARY figure beside each drawn count ("and 552 more of these exist"), and as the whole list when nothing is drawn yet. */
  storeTypes: TypeCount[];
  /** null when no node is selected. */
  selected?: TypePanelSelection | null;
  /** The type currently focused on the canvas, or null. */
  focusedType: string | null;
  /** A row was activated — App.tsx decides whether that turns focus on or off. */
  onToggleFocus: (nodeType: string) => void;
  /** App.tsx's store-wide type-colour rank map (bd-4ye, palette.ts's `assignTypeColors`) — the SAME map GraphCanvas and SearchBar read, so a row's swatch never disagrees with the canvas. */
  typeColors: ReadonlyMap<string, string>;
  /**
   * The relation families and source-system composition of the edges
   * actually drawn (bd-o1e, graph/edgeLegend.ts). Replaced the static
   * `knownSourceSystemColors()` footer, which named `repo`/`human`/`agent`
   * — three source systems present on essentially no edge in this store,
   * beside a canvas whose edges were all `git`.
   */
  edgeLegend: EdgeLegend;
}

function TypeRow({
  nodeType,
  count,
  storeCount,
  focused,
  onToggleFocus,
  swatchColor,
}: {
  nodeType: string;
  count: number;
  /** How many exist in the whole store, when that is more than are drawn. Secondary and dimmed — see TypePanelProps.storeTypes. */
  storeCount?: number | null;
  focused: boolean;
  onToggleFocus: (nodeType: string) => void;
  swatchColor: string;
}) {
  const showStore = typeof storeCount === "number" && storeCount > count;
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
        <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: swatchColor }} />
        <span className="flex-1 truncate text-fg">{nodeType}</span>
        <span className="shrink-0 text-fg">{count}</span>
        {showStore && (
          <span className="shrink-0 text-[10px] text-fg-muted" title={`${storeCount} in the store`}>
            /{storeCount}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The types the palette ran out of colours for, as one named group
 * (bd-857).
 *
 * `assignTypeColors` hands out CATEGORICAL_PALETTE's eight slots by
 * store-wide rank and gives every type past that the same
 * `FALLBACK_COLOR`. The panel used to hide those behind an "N more
 * types" disclosure, where they appeared as ordinary rows — six separate
 * entries, all drawing identically, presented as though they were
 * distinguishable. Naming them as one group is the honest version: the
 * canvas genuinely cannot tell them apart, and the reader should know
 * that before they try.
 */
function OverflowGroup({
  types,
  storeCountByType,
  showStore,
  focusedType,
  onToggleFocus,
}: {
  types: TypeCount[];
  storeCountByType: ReadonlyMap<string, number>;
  showStore: boolean;
  focusedType: string | null;
  onToggleFocus: (nodeType: string) => void;
}) {
  const total = types.reduce((sum, t) => sum + t.count, 0);
  return (
    // Open when one of its types is focused, so the row a person is
    // acting on is never hidden inside a collapsed disclosure.
    <details open={focusedType !== null && types.some((t) => t.nodeType === focusedType)}>
      <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[13px] hover:bg-surface-strong">
        <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: FALLBACK_COLOR }} />
        <span className="flex-1 truncate text-fg-muted">
          other ({types.length} type{types.length === 1 ? "" : "s"}, drawn alike)
        </span>
        <span className="shrink-0 text-fg-muted">{total}</span>
      </summary>
      {/*
        These are real controls, not labels (bd-857 review). The first
        version rendered them as plain spans, which removed the ONLY path
        to type focus for any type outside the store's top-8 rank — the
        search bar's suggestions add a chip but never set the focus. That
        is the exact row a reader most wants to act on: this commit's own
        argument is that a fallback-coloured type can rank first on the
        canvas.
      */}
      <ul className="mt-1 ml-4 flex flex-col gap-0.5">
        {types.map((t) => (
          <TypeRow
            key={t.nodeType}
            nodeType={t.nodeType}
            count={t.count}
            storeCount={showStore ? storeCountByType.get(t.nodeType) : null}
            focused={focusedType === t.nodeType}
            onToggleFocus={onToggleFocus}
            swatchColor={FALLBACK_COLOR}
          />
        ))}
      </ul>
    </details>
  );
}

export function TypePanel({ drawnTypes, storeTypes, selected, focusedType, onToggleFocus, typeColors, edgeLegend }: TypePanelProps) {
  const heading = selected ? `around ${selected.title || "(untitled)"}` : drawnTypes.length > 0 ? "On the canvas" : "In the store";
  // `topStoreTypes(storeTypes, storeTypes.length)` — "top all of them" —
  // reuses the one tested sort/tie-break rather than re-sorting inline;
  // slicing into visible/rest happens here since only this component
  // knows about the disclosure.
  // bd-857. Three views, and which one is showing decides what the counts
  // MEAN — so the heading says so rather than leaving the reader to infer
  // it from numbers that used to be silently store-wide:
  //   - a node is selected: its drawn neighbourhood's types (unchanged).
  //   - nodes are drawn: their types, counted on the canvas, with the
  //     store's own count as a dimmed secondary figure.
  //   - nothing is drawn (the state the explorer opens in): the store's
  //     types, which is the only thing there is to describe.
  const showingDrawn = !selected && drawnTypes.length > 0;
  const rows = selected ? selected.ranked : showingDrawn ? drawnTypes : topStoreTypes(storeTypes, storeTypes.length);
  const storeCountByType = new Map(storeTypes.map((t) => [t.nodeType, t.count]));

  // Types the palette had no colour left for draw identically, so they are
  // grouped rather than listed as though they were distinguishable. Split
  // out of the ranked rows wherever they fall, not just past a fixed
  // position — a fallback-coloured type can rank above a coloured one on
  // the canvas even though it ranked below it store-wide.
  const { coloured, overflow } = splitPaletteOverflow(rows, (t) => colorForNodeType(t, typeColors), FALLBACK_COLOR);
  // No slice, and no "N more types" disclosure: CATEGORICAL_PALETTE has
  // DEFAULT_VISIBLE_COUNT slots, so `coloured` can never exceed it and
  // the disclosure that used to sit here was unreachable code (bd-857
  // review). Everything past the palette is in `overflow` below, which is
  // where the disclosure actually belongs.
  const visible = coloured;

  return (
    <div className="flex flex-col gap-2 text-xs">
      <h2 className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{heading}</h2>

      {rows.length === 0 ? (
        <p className="text-fg-muted">{selected ? "no neighbours drawn" : "no types yet"}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <TypeRow
                key={row.nodeType}
                nodeType={row.nodeType}
                count={row.count}
                storeCount={showingDrawn ? storeCountByType.get(row.nodeType) : null}
                focused={focusedType === row.nodeType}
                onToggleFocus={onToggleFocus}
                swatchColor={colorForNodeType(row.nodeType, typeColors)}
              />
            ))}
          </ul>
          {overflow.length > 0 && (
            <OverflowGroup types={overflow} storeCountByType={storeCountByType} showStore={showingDrawn} focusedType={focusedType} onToggleFocus={onToggleFocus} />
          )}
        </>
      )}

      {edgeLegend.total > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-t border-hairline pt-2">
          {/*
            bd-o1e: the relation legend. One entry per family PRESENT on
            the canvas, each swatch drawn with that family's own dash so
            the legend and the edge look alike — an SVG line rather than a
            filled span, because a dash pattern is the thing being named.
          */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[10px] font-medium text-fg-muted uppercase">edge relation</span>
            {edgeLegend.families.map(({ family, count }) => (
              <span key={family.key} className="flex items-center gap-1" title={`${count} ${count === 1 ? "edge" : "edges"}`}>
                <svg aria-hidden width="14" height="4" viewBox="0 0 14 4" className="shrink-0 overflow-visible">
                  <line
                    x1="0"
                    y1="2"
                    x2="14"
                    y2="2"
                    stroke={family.color}
                    strokeWidth="1.5"
                    strokeDasharray={family.dash.length > 0 ? family.dash.join(" ") : undefined}
                  />
                  {family.arrow && <path d="M14 2 L10.5 0.2 L10.5 3.8 Z" fill={family.color} />}
                </svg>
                <span className="font-mono text-[10px] text-fg-muted">{family.label}</span>
              </span>
            ))}
          </div>
          {/*
            The composition line — what survives of the removed "Edge
            provenance is visible" requirement (see graph/edgeLegend.ts's
            header). One source system listed here IS "every edge in this
            view came from one loader", said outright.
          */}
          <p className="text-[10px] text-fg-muted">
            <span className="font-medium uppercase">from</span>{" "}
            {edgeLegend.sourceSystems.map(({ sourceSystem, count }, i) => (
              <span key={sourceSystem}>
                {i > 0 && " · "}
                <span className="font-mono">{sourceSystem}</span> {count}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}
