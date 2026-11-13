// A decision card's own sections in the review panel (decision-card-reviews,
// design.md decision 7, layout A): the question; `Options · N` as one list,
// the recommended option first — accent-bordered, a Recommended chip, its
// full what and risk — and each other option below it with what and risk
// clamped to two lines (the full text stays in the accessible text and the
// tooltip, and is shown in full while that option's decision button has
// focus — the button is described by it, and the list scrolls it into
// view); the on-accept steps; and the evidence (the bead description
// through EvidenceView), behind a disclosure control when the card has
// options and open otherwise. ReviewItemPanel places these around the
// attachments and the thread. All text is React text; backtick spans are
// the one inline mark (lib/reviewCard.ts `splitInlineCode`).

import { useEffect, useId, useRef, useState } from "react";
import { orderedOptions, recommendedOption, splitInlineCode, type CardLike, type CardOption } from "../lib/reviewCard.js";
import { EvidenceView } from "./EvidenceView.js";
import { SectionTitle } from "./ReviewAttachments.js";

export function InlineText({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((s, i) =>
        s.code ? (
          <code key={i} className="rounded bg-fg/10 px-1 py-px font-mono text-[0.85em] text-fg">
            {s.text}
          </code>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

export function CardQuestion({ question }: { question: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id}>Question</SectionTitle>
      <p className="text-[17px] font-semibold leading-snug text-fg">
        <InlineText text={question} />
      </p>
    </section>
  );
}

export function IdBadge({ id, accent }: { id: string; accent: boolean }) {
  return (
    <span aria-hidden="true" className={`grid h-5 min-w-5 shrink-0 place-items-center rounded px-1 font-mono text-[11px] font-semibold ${accent ? "bg-accent text-ground" : "bg-fg/10 text-fg-muted"}`}>
      {id}
    </span>
  );
}

function RiskLine({ risk, small, clamp }: { risk: string; small: boolean; clamp: boolean }) {
  return (
    <p title={clamp ? risk : undefined} className={`leading-snug text-fg/85 ${small ? "text-xs" : "text-sm"} ${clamp ? "line-clamp-2" : ""}`}>
      <span className="font-semibold text-amber-200/90">Risk </span>
      <InlineText text={risk} />
    </p>
  );
}

function OptionItem({ option, recommended, clamp, focused, descId }: { option: CardOption; recommended: boolean; clamp: boolean; focused: boolean; descId: string }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  return (
    <li ref={ref} data-focused={focused ? "" : undefined} className={`border-l-2 px-3 ${recommended ? "border-accent bg-accent/[0.09] py-2.5" : `py-2 ${focused ? "border-accent/60 bg-accent/[0.05]" : "border-transparent"}`}`}>
      <div className="flex items-center gap-2">
        <IdBadge id={option.id} accent={recommended} />
        <span className={`min-w-0 text-sm text-fg ${recommended ? "font-semibold" : "font-medium"}`}>
          <span className="sr-only">Option {option.id}: </span>
          {option.label}
        </span>
        {recommended && <span className="ml-auto shrink-0 rounded-full border border-accent/60 bg-accent/15 px-2 py-0.5 text-[11px] text-fg">Recommended</span>}
      </div>
      <div id={descId}>
        {option.what !== undefined && (
          <p title={clamp ? option.what : undefined} className={`leading-snug ${recommended ? "mt-1.5 text-sm text-fg/90" : "mt-1 text-xs text-fg-muted"} ${clamp ? "line-clamp-2" : ""}`}>
            <InlineText text={option.what} />
          </p>
        )}
        {option.risk !== undefined && (
          <div className={recommended ? "mt-1" : "mt-0.5"}>
            <RiskLine risk={option.risk} small={!recommended} clamp={clamp} />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The options, the recommended one first. Without a recommendation none is
 * clamped: no option is singled out. `focused` is the option whose decision
 * button has focus (shown in full); `descId` names each option's what/risk.
 */
export function CardOptions({ card, focused, descId }: { card: CardLike; focused: string | null; descId: (id: string) => string }) {
  const id = useId();
  if (card.options.length === 0) return null;
  const recommended = recommendedOption(card);
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id}>Options · {card.options.length}</SectionTitle>
      <ol className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
        {orderedOptions(card).map((o) => (
          <OptionItem key={o.id} option={o} recommended={o === recommended} clamp={recommended !== null && o !== recommended && focused !== o.id} focused={focused === o.id} descId={descId(o.id)} />
        ))}
      </ol>
    </section>
  );
}

export function CardOnAccept({ steps }: { steps: readonly string[] }) {
  const id = useId();
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id}>
        On accept · {steps.length} step{steps.length === 1 ? "" : "s"}
      </SectionTitle>
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-snug text-fg/90 marker:text-fg-muted">
        {steps.map((step, i) => (
          <li key={i}>
            <InlineText text={step} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The evidence, in a section its heading names. `collapsible` (a card with
 * options) starts it collapsed behind a disclosure button that expands it in
 * place; EvidenceView mounts only once it is open, so a collapsed card never
 * fetches the diagram renderer.
 */
export function CardEvidence({ markdown, collapsible }: { markdown: string; collapsible: boolean }) {
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(!collapsible);
  const shown = open || !collapsible;
  return (
    <section aria-labelledby={headingId}>
      {collapsible ? (
        <h3 id={headingId} className={shown ? "mb-2" : undefined}>
          <button
            type="button"
            aria-expanded={shown}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            className={`flex w-full items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${shown ? "rounded" : "rounded-lg border border-hairline px-3 py-2.5 hover:bg-fg/5"}`}
          >
            <span aria-hidden="true" className="w-3 text-fg-muted">
              {shown ? "▾" : "▸"}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Evidence</span>
            <span aria-hidden="true" className="ml-auto text-xs text-accent">
              {shown ? "Hide" : "Show"}
            </span>
          </button>
        </h3>
      ) : (
        <SectionTitle id={headingId}>Evidence</SectionTitle>
      )}
      <div id={bodyId} hidden={!shown}>
        {shown && <EvidenceView markdown={markdown} />}
      </div>
    </section>
  );
}
