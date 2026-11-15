// The milestone a board lane's epic belongs to (roadmap-milestones, design.md
// decision 4), in the lane header: an accent-tinted pill with a dashed
// border, so it reads apart from the epic's status pill (solid hairline) and
// its card count. "milestone" is said to screen readers, not shown.

export interface LaneMilestoneProps {
  title: string;
}

export function LaneMilestone({ title }: LaneMilestoneProps) {
  return (
    <span data-lane-milestone className="min-w-0 max-w-[16rem] shrink truncate rounded-full border border-dashed border-accent/60 bg-accent/10 px-2 py-0.5 text-[11px] font-normal text-accent">
      <span aria-hidden="true">◇ </span>
      <span className="sr-only">milestone </span>
      {title}
    </span>
  );
}
