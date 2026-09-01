// Colour legend for the graph canvas (bd-hmd.4). Not required by the
// spec text itself, but it's what makes "edge provenance is visible ...
// distinguishable at a glance" and the node-type colouring verifiable
// by a person looking at the page, and it's the dataviz skill's own
// rule for a categorical encoding ("a legend is always present for >= 2
// series") — colour is never the graph's only way of saying what a
// node/edge is (every node also carries a text label; palette.ts's
// header documents why that matters for the six-node-type palette
// specifically).

import { FALLBACK_COLOR, knownNodeTypeColors, knownSourceSystemColors } from "../graph/palette.js";

function Swatch({ color, shape }: { color: string; shape: "circle" | "line" }) {
  if (shape === "circle") {
    return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
  }
  return <span className="inline-block h-0.5 w-3.5 shrink-0" style={{ backgroundColor: color }} />;
}

function LegendRow({ label, color, shape }: { label: string; color: string; shape: "circle" | "line" }) {
  return (
    <div className="flex items-center gap-1.5">
      <Swatch color={color} shape={shape} />
      <span className="font-mono text-[11px] text-slate-600">{label}</span>
    </div>
  );
}

export function GraphLegend() {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-medium text-slate-400">node type</span>
        {knownNodeTypeColors().map(([type, color]) => (
          <LegendRow key={type} label={type} color={color} shape="circle" />
        ))}
        <LegendRow label="other" color={FALLBACK_COLOR} shape="circle" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-medium text-slate-400">edge source</span>
        {knownSourceSystemColors().map(([system, color]) => (
          <LegendRow key={system} label={system} color={color} shape="line" />
        ))}
        <LegendRow label="other" color={FALLBACK_COLOR} shape="line" />
      </div>
    </div>
  );
}
